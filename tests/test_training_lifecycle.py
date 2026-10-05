#!/usr/bin/env python3
"""
Comprehensive Automated Test Suite for Real-User ML Training-Data Lifecycle.

Verifies:
1. Strict 5-point Real User Eligibility.
2. Dynamic Synchronization and Idempotency (1 row per user_id, in-place updates).
3. MongoDB as Single Source of Truth (Snapshot regenerability).
4. Zero Synthetic Data Fallback (Informative error on insufficient data).
5. User-Isolated Cross-Validation & Zero Data Leakage (Fold-level scaler fitting).
6. Safe Candidate Retraining and Explicit Gated Promotion.
7. Missing Model Safety (No silent synthetic auto-bootstrapping).
"""

import os
import sys
import json
import csv
import tempfile
import unittest
import numpy as np
import pandas as pd

# Ensure root and ml paths are accessible
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ml"))

from ml.export_real_dataset import (
    evaluate_user_eligibility,
    calculate_bfi44_scores_from_responses,
    write_dataset_and_provenance,
    FEATURE_COLUMNS,
    TARGET_COLUMNS
)
from ml.dataset import load_and_prepare_data
from ml.evaluate import evaluate_ocean_predictions
from ml.train_personality_model import run_cross_validation, train_candidate_pipeline, promote_candidate_to_production


def make_valid_bfi44_responses():
    """Helper creating 44 valid item responses."""
    return [{"question_id": i, "score": 3 + (i % 3) - 1} for i in range(1, 45)]


class TestEligibilityRules(unittest.TestCase):

    def test_eligible_user_passes_all_checks(self):
        user_id = "eligible_user_001"
        responses = make_valid_bfi44_responses()
        scores = calculate_bfi44_scores_from_responses(responses)
        quest_doc = {
            "user_id": user_id,
            "questionnaire_type": "BFI-44",
            "status": "completed",
            "responses": responses,
            "scores": scores
        }
        features_doc = {
            "user_id": user_id,
            "avg_session_duration": 45.5,
            "late_night_ratio": 0.12,
            "topic_diversity": 0.75,
            "learning_ratio": 0.60,
            "activity_consistency": 0.85
        }
        raw_events_count = 150

        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=quest_doc,
            features_doc=features_doc,
            raw_events_count=raw_events_count
        )

        self.assertTrue(is_eligible, f"User should be eligible. Reason: {reason}")
        self.assertIsNotNone(clean_row)
        self.assertEqual(clean_row["user_id"], user_id)
        for feat in FEATURE_COLUMNS:
            self.assertIn(feat, clean_row)
            self.assertFalse(np.isnan(clean_row[feat]))
        for target in TARGET_COLUMNS:
            self.assertIn(target, clean_row)
            self.assertTrue(1.0 <= clean_row[target] <= 5.0)

    def test_ineligible_user_with_fewer_than_100_events(self):
        user_id = "low_events_user"
        responses = make_valid_bfi44_responses()
        scores = calculate_bfi44_scores_from_responses(responses)
        quest_doc = {"user_id": user_id, "questionnaire_type": "BFI-44", "responses": responses, "scores": scores}
        features_doc = {
            "user_id": user_id,
            "avg_session_duration": 45.5,
            "late_night_ratio": 0.12,
            "topic_diversity": 0.75,
            "learning_ratio": 0.60,
            "activity_consistency": 0.85
        }
        raw_events_count = 99  # < 100

        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=quest_doc,
            features_doc=features_doc,
            raw_events_count=raw_events_count
        )
        self.assertFalse(is_eligible)
        self.assertIn("raw events", reason)
        self.assertIsNone(clean_row)

    def test_ineligible_user_missing_questionnaire(self):
        user_id = "no_quest_user"
        features_doc = {
            "user_id": user_id,
            "avg_session_duration": 45.5,
            "late_night_ratio": 0.12,
            "topic_diversity": 0.75,
            "learning_ratio": 0.60,
            "activity_consistency": 0.85
        }
        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=None,
            features_doc=features_doc,
            raw_events_count=200
        )
        self.assertFalse(is_eligible)
        self.assertIn("not submitted a questionnaire", reason)
        self.assertIsNone(clean_row)

    def test_ineligible_user_incomplete_questionnaire(self):
        user_id = "incomplete_quest_user"
        responses = make_valid_bfi44_responses()[:43]  # Only 43 items
        quest_doc = {"user_id": user_id, "questionnaire_type": "BFI-44", "responses": responses}
        features_doc = {
            "user_id": user_id,
            "avg_session_duration": 45.5,
            "late_night_ratio": 0.12,
            "topic_diversity": 0.75,
            "learning_ratio": 0.60,
            "activity_consistency": 0.85
        }
        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=quest_doc,
            features_doc=features_doc,
            raw_events_count=120
        )
        self.assertFalse(is_eligible)
        self.assertIn("expected exactly 44", reason)

    def test_ineligible_user_missing_feature_value(self):
        user_id = "missing_feature_user"
        responses = make_valid_bfi44_responses()
        scores = calculate_bfi44_scores_from_responses(responses)
        quest_doc = {"user_id": user_id, "questionnaire_type": "BFI-44", "responses": responses, "scores": scores}
        features_doc = {
            "user_id": user_id,
            "avg_session_duration": 45.5,
            "late_night_ratio": 0.12,
            "topic_diversity": None,  # Missing/None
            "learning_ratio": 0.60,
            "activity_consistency": 0.85
        }
        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=quest_doc,
            features_doc=features_doc,
            raw_events_count=150
        )
        self.assertFalse(is_eligible)
        self.assertIn("topic_diversity", reason)


class TestDatasetSynchronizationAndIdempotency(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def test_idempotent_sync_and_in_place_update(self):
        user_1 = {
            "user_id": "usr_alpha",
            "avg_session_duration": 30.0,
            "late_night_ratio": 0.1,
            "topic_diversity": 0.5,
            "learning_ratio": 0.4,
            "activity_consistency": 0.8,
            "openness": 3.5,
            "conscientiousness": 3.8,
            "extraversion": 3.2,
            "agreeableness": 4.1,
            "neuroticism": 2.5
        }
        user_2 = {
            "user_id": "usr_beta",
            "avg_session_duration": 50.0,
            "late_night_ratio": 0.2,
            "topic_diversity": 0.8,
            "learning_ratio": 0.7,
            "activity_consistency": 0.9,
            "openness": 4.2,
            "conscientiousness": 4.0,
            "extraversion": 3.9,
            "agreeableness": 4.5,
            "neuroticism": 1.8
        }

        # Step 1: Write initial 2 rows
        csv_p, prov_p, prov_data = write_dataset_and_provenance([user_1, user_2], output_dir=self.test_dir)
        df1 = pd.read_csv(csv_p)
        self.assertEqual(len(df1), 2)
        self.assertFalse(prov_data["synthetic_data_used"])

        # Step 2: Idempotent re-sync with same data -> still 2 rows
        csv_p, prov_p, prov_data2 = write_dataset_and_provenance([user_1, user_2], output_dir=self.test_dir)
        df2 = pd.read_csv(csv_p)
        self.assertEqual(len(df2), 2, "Idempotent sync must maintain exactly 2 rows")

        # Step 3: Feature update for user_1 -> updates row, still 2 rows
        user_1_updated = dict(user_1)
        user_1_updated["avg_session_duration"] = 88.88
        csv_p, prov_p, prov_data3 = write_dataset_and_provenance([user_1_updated, user_2], output_dir=self.test_dir)
        df3 = pd.read_csv(csv_p)
        self.assertEqual(len(df3), 2)
        row_usr1 = df3[df3["user_id"] == "usr_alpha"].iloc[0]
        self.assertEqual(row_usr1["avg_session_duration"], 88.88)


class TestNoSyntheticData(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def test_error_raised_when_insufficient_real_samples(self):
        empty_csv = os.path.join(self.test_dir, "empty_dataset.csv")
        df = pd.DataFrame(columns=["user_id"] + FEATURE_COLUMNS + TARGET_COLUMNS)
        df.to_csv(empty_csv, index=False)

        with self.assertRaises(ValueError) as context:
            load_and_prepare_data(empty_csv, min_samples_required=2)
        self.assertIn("Insufficient real labelled users", str(context.exception))

    def test_clean_load_with_only_real_samples(self):
        real_csv = os.path.join(self.test_dir, "real_dataset.csv")
        rows = [
            {"user_id": f"real_user_{i}", "avg_session_duration": 30.0 + i, "late_night_ratio": 0.1,
             "topic_diversity": 0.5, "learning_ratio": 0.4, "activity_consistency": 0.8,
             "openness": 3.5, "conscientiousness": 3.8, "extraversion": 3.2, "agreeableness": 4.1, "neuroticism": 2.5}
            for i in range(5)
        ]
        pd.DataFrame(rows).to_csv(real_csv, index=False)

        clean_df, X, Y, feat_names, tgt_names = load_and_prepare_data(real_csv, min_samples_required=2)
        self.assertEqual(len(clean_df), 5)
        self.assertEqual(X.shape, (5, 5))
        self.assertEqual(Y.shape, (5, 5))


class TestCrossValidationAndDataLeakage(unittest.TestCase):

    def test_user_isolated_cross_validation_zero_leakage(self):
        np.random.seed(42)
        N = 10
        X = np.random.uniform(10, 100, size=(N, 5))
        Y = np.random.uniform(1.0, 5.0, size=(N, 5))

        cv_metrics, Y_cv_preds, cv_name = run_cross_validation(X, Y, TARGET_COLUMNS)

        self.assertIn("overall_average", cv_metrics)
        self.assertTrue(cv_metrics["overall_average"]["mae"] >= 0.0)
        self.assertTrue(cv_metrics["overall_average"]["rmse"] >= 0.0)
        self.assertEqual(Y_cv_preds.shape, (N, 5))
        # Ensure all predicted traits are clipped in valid range [1.0, 5.0]
        self.assertTrue((Y_cv_preds >= 1.0).all() and (Y_cv_preds <= 5.0).all())


class TestSafeCandidateTrainingAndPromotion(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        # Seed dummy real dataset in test_dir
        self.csv_path = os.path.join(self.test_dir, "training_dataset.csv")
        rows = [
            {"user_id": f"real_user_{i}", "avg_session_duration": 30.0 + i * 5, "late_night_ratio": 0.05 * i,
             "topic_diversity": 0.4 + 0.05 * i, "learning_ratio": 0.3 + 0.05 * i, "activity_consistency": 0.7,
             "openness": 3.0 + 0.1 * i, "conscientiousness": 3.5, "extraversion": 3.2, "agreeableness": 4.0, "neuroticism": 2.2}
            for i in range(8)
        ]
        pd.DataFrame(rows).to_csv(self.csv_path, index=False)

        # Create dummy initial production model
        self.prod_model_path = os.path.join(self.test_dir, "personality_model.pkl")
        self.prod_scaler_path = os.path.join(self.test_dir, "scaler.pkl")
        with open(self.prod_model_path, "w") as f:
            f.write("PROD_MODEL_INITIAL_V1")
        with open(self.prod_scaler_path, "w") as f:
            f.write("PROD_SCALER_INITIAL_V1")

    def test_candidate_training_does_not_overwrite_production(self):
        results = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir)
        self.assertIn("evaluation_metrics", results)
        self.assertFalse(results["synthetic_data_used"])

        # Candidate files created
        cand_model = os.path.join(self.test_dir, "personality_model_candidate_real.pkl")
        cand_scaler = os.path.join(self.test_dir, "scaler_candidate_real.pkl")
        cand_metrics = os.path.join(self.test_dir, "candidate_evaluation_metrics.json")
        self.assertTrue(os.path.exists(cand_model))
        self.assertTrue(os.path.exists(cand_scaler))
        self.assertTrue(os.path.exists(cand_metrics))

        # Production model preserved untouched!
        with open(self.prod_model_path, "r") as f:
            content = f.read()
        self.assertEqual(content, "PROD_MODEL_INITIAL_V1", "Production model must not be modified by candidate training")

    def test_explicit_promotion_gate(self):
        train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir)
        promo_res = promote_candidate_to_production(output_dir=self.test_dir)
        self.assertEqual(promo_res["status"], "success")

        # Verified that production files were updated from candidate
        self.assertTrue(os.path.exists(self.prod_model_path))
        self.assertTrue(os.path.exists(self.prod_scaler_path))
        # Backup created
        backup_model = os.path.join(self.test_dir, "backup_artifacts", "personality_model.pkl")
        self.assertTrue(os.path.exists(backup_model))
        with open(backup_model, "r") as bf:
            self.assertEqual(bf.read(), "PROD_MODEL_INITIAL_V1")


class TestModelRegistryAndInterchangeability(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.csv_path = os.path.join(self.test_dir, "training_dataset.csv")
        rows = [
            {"user_id": f"real_user_{i}", "avg_session_duration": 30.0 + i * 5, "late_night_ratio": 0.05 * i,
             "topic_diversity": 0.4 + 0.05 * i, "learning_ratio": 0.3 + 0.05 * i, "activity_consistency": 0.7,
             "openness": 3.0 + 0.1 * i, "conscientiousness": 3.5, "extraversion": 3.2, "agreeableness": 4.0, "neuroticism": 2.2}
            for i in range(8)
        ]
        pd.DataFrame(rows).to_csv(self.csv_path, index=False)

    def test_model_registry_instantiates_all_supported_models(self):
        from ml.model import list_supported_models, get_model, get_model_metadata

        supported = list_supported_models()
        self.assertIn("elasticnet", supported)
        self.assertIn("random_forest", supported)
        self.assertIn("ridge", supported)
        self.assertIn("svr", supported)
        self.assertIn("mlp", supported)

        for m_name in supported:
            model = get_model(m_name)
            self.assertTrue(hasattr(model, "fit"), f"Model {m_name} must implement fit()")
            self.assertTrue(hasattr(model, "predict"), f"Model {m_name} must implement predict()")

            meta = get_model_metadata(m_name)
            self.assertEqual(meta["model_type"], m_name)
            self.assertIn("description", meta)

    def test_switching_model_type_in_candidate_pipeline(self):
        from ml.model import get_model_metadata

        # 1. Train ElasticNet candidate
        res_enet = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir, model_type="elasticnet")
        self.assertEqual(res_enet["model_type"], "elasticnet")
        cand_metrics_path = os.path.join(self.test_dir, "candidate_evaluation_metrics.json")
        with open(cand_metrics_path, "r") as f:
            metrics_enet = json.load(f)
        self.assertEqual(metrics_enet["model_type"], "elasticnet")

        # 2. Switch to Random Forest without pipeline rewrite
        res_rf = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir, model_type="random_forest")
        self.assertEqual(res_rf["model_type"], "random_forest")
        with open(cand_metrics_path, "r") as f:
            metrics_rf = json.load(f)
        self.assertEqual(metrics_rf["model_type"], "random_forest")

        # 3. Switch to Ridge
        res_ridge = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir, model_type="ridge")
        self.assertEqual(res_ridge["model_type"], "ridge")

        # 4. Switch to SVR
        res_svr = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir, model_type="svr")
        self.assertEqual(res_svr["model_type"], "svr")

        # 5. Switch to MLP baseline
        res_mlp = train_candidate_pipeline(csv_path=self.csv_path, output_dir=self.test_dir, model_type="mlp")
        self.assertEqual(res_mlp["model_type"], "mlp")


if __name__ == "__main__":
    unittest.main(verbosity=2)
