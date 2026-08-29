#!/usr/bin/env python3
"""
Real-User ML Training Dataset Synchronization Engine.

MongoDB is the SINGLE SOURCE OF TRUTH.
`training_dataset.csv` is strictly a generated snapshot/cache.
`dataset_provenance.json` records complete dataset metadata and verifies synthetic_data_used: false.
"""

import os
import sys
import json
import math
import csv
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple

FEATURE_COLUMNS = [
    "avg_session_duration",
    "late_night_ratio",
    "topic_diversity",
    "learning_ratio",
    "activity_consistency"
]

TARGET_COLUMNS = [
    "openness",
    "conscientiousness",
    "extraversion",
    "agreeableness",
    "neuroticism"
]

CSV_HEADERS = ["user_id"] + FEATURE_COLUMNS + TARGET_COLUMNS

MIN_REQUIRED_EVENTS = 100


def clean_score(val: Any) -> Optional[float]:
    """Safely converts and validates psychometric score in [1.0, 5.0]."""
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(min(5.0, max(1.0, f)), 2)
    except (ValueError, TypeError):
        return None


def clean_feature(val: Any, min_val: float = 0.0, max_val: Optional[float] = None) -> Optional[float]:
    """Safely validates numeric feature value."""
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        if max_val is not None:
            f = min(max_val, max(min_val, f))
        else:
            f = max(min_val, f)
        return round(f, 3)
    except (ValueError, TypeError):
        return None


def calculate_bfi44_scores_from_responses(responses: List[dict]) -> Optional[Dict[str, float]]:
    """Calculates standardized OCEAN scores from 44 BFI responses."""
    if not isinstance(responses, list) or len(responses) != 44:
        return None

    score_map = {}
    for r in responses:
        if not isinstance(r, dict):
            return None
        try:
            q_id = int(r.get("question_id"))
            score = int(r.get("score"))
            if q_id < 1 or q_id > 44 or score < 1 or score > 5:
                return None
            score_map[q_id] = score
        except (ValueError, TypeError):
            return None

    if len(score_map) != 44:
        return None

    def get_score(q_id: int, is_reverse: bool) -> int:
        raw = score_map.get(q_id, 3)
        return (6 - raw) if is_reverse else raw

    extraversion_items = [
        get_score(1, False), get_score(6, True), get_score(11, False), get_score(16, False),
        get_score(21, True), get_score(26, False), get_score(31, True), get_score(36, False)
    ]
    agreeableness_items = [
        get_score(2, True), get_score(7, False), get_score(12, True), get_score(17, False),
        get_score(22, False), get_score(27, True), get_score(32, False), get_score(37, True), get_score(42, False)
    ]
    conscientiousness_items = [
        get_score(3, False), get_score(8, True), get_score(13, False), get_score(18, True),
        get_score(23, True), get_score(28, False), get_score(33, False), get_score(38, False), get_score(43, True)
    ]
    neuroticism_items = [
        get_score(4, False), get_score(9, True), get_score(14, False), get_score(19, False),
        get_score(24, True), get_score(29, False), get_score(34, True), get_score(39, False)
    ]
    openness_items = [
        get_score(5, False), get_score(10, False), get_score(15, False), get_score(20, False),
        get_score(25, False), get_score(30, False), get_score(35, True), get_score(40, False),
        get_score(41, True), get_score(44, False)
    ]

    avg = lambda arr: round(sum(arr) / len(arr), 2)
    return {
        "extraversion": avg(extraversion_items),
        "agreeableness": avg(agreeableness_items),
        "conscientiousness": avg(conscientiousness_items),
        "neuroticism": avg(neuroticism_items),
        "openness": avg(openness_items)
    }


def evaluate_user_eligibility(
    user_id: str,
    quest_doc: Optional[Dict[str, Any]],
    features_doc: Optional[Dict[str, Any]],
    raw_events_count: int
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """
    Evaluates whether a user meets all 5 strict real-training-data eligibility criteria:
    1. Completed BFI-44 with exactly 44 valid item responses and valid OCEAN ground-truth scores.
    2. At least 100 raw behavioral events.
    3. Valid 5-feature behavioral vector.
    4. Zero null, NaN, missing, or invalid values across all 5 features and 5 targets.
    5. Ground truth labels derived SOLELY from BFI-44 questionnaire (never predictions).
    """
    if not user_id or not isinstance(user_id, str) or not user_id.strip():
        return False, "Missing or invalid user_id", None

    # 1. Check Questionnaire
    if not quest_doc:
        return False, f"User {user_id} has not submitted a questionnaire", None

    if quest_doc.get("questionnaire_type") != "BFI-44":
        return False, f"User {user_id} questionnaire type is {quest_doc.get('questionnaire_type')}, expected BFI-44", None

    responses = quest_doc.get("responses", [])
    if not isinstance(responses, list) or len(responses) != 44:
        return False, f"User {user_id} has {len(responses) if isinstance(responses, list) else 0} responses, expected exactly 44", None

    ocean_scores = quest_doc.get("scores")
    if not isinstance(ocean_scores, dict) or not all(k in ocean_scores for k in TARGET_COLUMNS):
        ocean_scores = calculate_bfi44_scores_from_responses(responses)

    if not ocean_scores:
        return False, f"User {user_id} BFI-44 responses could not be scored into valid OCEAN traits", None

    clean_targets = {}
    for trait in TARGET_COLUMNS:
        score = clean_score(ocean_scores.get(trait))
        if score is None:
            return False, f"User {user_id} has invalid/missing target score for trait '{trait}'", None
        clean_targets[trait] = score

    # 2. Check Behavioral Events Count (>= 100)
    if raw_events_count < MIN_REQUIRED_EVENTS:
        return False, f"User {user_id} has only {raw_events_count} raw events (< {MIN_REQUIRED_EVENTS} required)", None

    # 3 & 4. Check 5 Behavioral Features
    if not features_doc or not isinstance(features_doc, dict):
        return False, f"User {user_id} has no computed user_features", None

    clean_features = {}
    # avg_session_duration
    asd = clean_feature(features_doc.get("avg_session_duration"), min_val=0.01)
    if asd is None:
        return False, f"User {user_id} has invalid/missing avg_session_duration", None
    clean_features["avg_session_duration"] = asd

    # late_night_ratio
    lnr = clean_feature(features_doc.get("late_night_ratio"), min_val=0.0, max_val=1.0)
    if lnr is None:
        return False, f"User {user_id} has invalid/missing late_night_ratio", None
    clean_features["late_night_ratio"] = lnr

    # topic_diversity
    td = clean_feature(features_doc.get("topic_diversity"), min_val=0.0, max_val=1.0)
    if td is None:
        return False, f"User {user_id} has invalid/missing topic_diversity", None
    clean_features["topic_diversity"] = td

    # learning_ratio
    lr = clean_feature(features_doc.get("learning_ratio"), min_val=0.0, max_val=1.0)
    if lr is None:
        return False, f"User {user_id} has invalid/missing learning_ratio", None
    clean_features["learning_ratio"] = lr

    # activity_consistency
    ac = clean_feature(features_doc.get("activity_consistency"), min_val=0.0, max_val=1.0)
    if ac is None:
        return False, f"User {user_id} has invalid/missing activity_consistency", None
    clean_features["activity_consistency"] = ac

    # Construct clean training row
    training_row = {
        "user_id": user_id.strip(),
        **clean_features,
        **clean_targets
    }

    return True, "Eligible", training_row


def get_default_dataset_paths(output_dir: Optional[str] = None) -> Tuple[str, str]:
    """Resolves absolute paths to training_dataset.csv and dataset_provenance.json."""
    if output_dir is None or output_dir == "/ml":
        base_dir = os.path.dirname(os.path.abspath(__file__))
    elif not os.path.isabs(output_dir):
        base_dir = os.path.abspath(output_dir)
    else:
        base_dir = output_dir

    os.makedirs(base_dir, exist_ok=True)
    csv_path = os.path.join(base_dir, "training_dataset.csv")
    prov_path = os.path.join(base_dir, "dataset_provenance.json")
    return csv_path, prov_path


def write_dataset_and_provenance(
    rows: List[Dict[str, Any]],
    output_dir: Optional[str] = None,
    last_retrained_count: Optional[int] = None
) -> Tuple[str, str, Dict[str, Any]]:
    """Writes dataset rows to CSV snapshot and generates dataset_provenance.json."""
    csv_path, prov_path = get_default_dataset_paths(output_dir)

    # Ensure rows are sorted deterministically by user_id
    sorted_rows = sorted(rows, key=lambda r: str(r.get("user_id", "")))

    # Write CSV
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        writer.writeheader()
        for r in sorted_rows:
            writer.writerow({k: r.get(k, "") for k in CSV_HEADERS})

    # Read existing provenance if present to preserve retrain tracking
    existing_last_retrained = 0
    if os.path.exists(prov_path):
        try:
            with open(prov_path, "r", encoding="utf-8") as pf:
                old_p = json.load(pf)
                existing_last_retrained = old_p.get("last_retrained_eligible_count", 0)
        except Exception:
            pass

    retrained_count = last_retrained_count if last_retrained_count is not None else existing_last_retrained

    provenance_data = {
        "dataset_version": "v1.0.0-real",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "synthetic_data_used": False,
        "eligible_users_count": len(sorted_rows),
        "user_ids": [r["user_id"] for r in sorted_rows],
        "feature_names": FEATURE_COLUMNS,
        "target_names": TARGET_COLUMNS,
        "last_retrained_eligible_count": retrained_count,
        "new_eligible_users_since_last_retrain": max(0, len(sorted_rows) - retrained_count),
        "eligibility_criteria": {
            "min_raw_behavioral_events": MIN_REQUIRED_EVENTS,
            "bfi44_required_responses_count": 44,
            "required_behavioral_features": FEATURE_COLUMNS,
            "required_target_traits": TARGET_COLUMNS,
            "target_label_source": "MongoDB questionnaire_responses.scores (BFI-44 ground truth only)",
            "model_predictions_used_as_labels": False,
            "imputation_used": False,
            "synthetic_augmentation_used": False
        },
        "csv_file_path": os.path.basename(csv_path)
    }

    with open(prov_path, "w", encoding="utf-8") as pf:
        json.dump(provenance_data, pf, indent=2)

    return csv_path, prov_path, provenance_data


async def fetch_eligible_users_from_db(db) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Queries MongoDB and returns list of eligible training user rows and ineligible details."""
    if db is None:
        raise ConnectionError("MongoDB database connection is None")

    # Fetch all BFI-44 questionnaires
    questionnaires = await db.questionnaire_responses.find({"questionnaire_type": "BFI-44"}).to_list(None)

    eligible_rows_map = {}
    ineligible_logs = []

    for q_doc in questionnaires:
        user_id = q_doc.get("user_id")
        if not user_id:
            continue

        raw_count = await db.raw_events.count_documents({"user_id": user_id})
        feat_doc = await db.user_features.find_one({"user_id": user_id})

        is_eligible, reason, clean_row = evaluate_user_eligibility(
            user_id=user_id,
            quest_doc=q_doc,
            features_doc=feat_doc,
            raw_events_count=raw_count
        )

        if is_eligible and clean_row:
            eligible_rows_map[user_id] = clean_row
        else:
            ineligible_logs.append({
                "user_id": user_id,
                "reason": reason,
                "raw_events_count": raw_count,
                "has_features": bool(feat_doc)
            })

    eligible_rows = list(eligible_rows_map.values())
    return eligible_rows, ineligible_logs


async def sync_real_training_dataset(db, output_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Synchronizes the entire real-user training dataset from MongoDB to CSV and provenance JSON.
    Idempotent: 1 row per user_id, zero duplicates.
    """
    eligible_rows, ineligible_logs = await fetch_eligible_users_from_db(db)
    csv_path, prov_path, prov_data = write_dataset_and_provenance(eligible_rows, output_dir=output_dir)

    return {
        "status": "success",
        "eligible_users_count": len(eligible_rows),
        "ineligible_users_count": len(ineligible_logs),
        "user_ids": [r["user_id"] for r in eligible_rows],
        "csv_path": csv_path,
        "provenance_path": prov_path,
        "synthetic_data_used": False,
        "provenance": prov_data,
        "ineligible_details": ineligible_logs
    }


async def sync_user_to_training_dataset(user_id: str, db, output_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Idempotently synchronizes a single user into the training dataset CSV and provenance JSON.
    - If the user is eligible, inserts or updates their row in the CSV snapshot.
    - If the user is not eligible (or feature became invalid), removes them from the CSV snapshot.
    - Preserves exactly one row per user_id.
    """
    if db is None:
        raise ConnectionError("MongoDB database connection is None")

    if not user_id or not isinstance(user_id, str) or not user_id.strip():
        return {"status": "error", "message": "Invalid user_id"}

    target_user_id = user_id.strip()
    q_doc = await db.questionnaire_responses.find_one({"user_id": target_user_id, "questionnaire_type": "BFI-44"})
    feat_doc = await db.user_features.find_one({"user_id": target_user_id})
    raw_count = await db.raw_events.count_documents({"user_id": target_user_id})

    is_eligible, reason, clean_row = evaluate_user_eligibility(
        user_id=target_user_id,
        quest_doc=q_doc,
        features_doc=feat_doc,
        raw_events_count=raw_count
    )

    csv_path, prov_path = get_default_dataset_paths(output_dir)

    # Read existing rows from CSV if present
    existing_rows_map = {}
    if os.path.exists(csv_path):
        try:
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    uid = row.get("user_id")
                    if uid:
                        existing_rows_map[uid] = row
        except Exception:
            existing_rows_map = {}

    action = "none"
    if is_eligible and clean_row:
        if target_user_id in existing_rows_map:
            action = "updated"
        else:
            action = "inserted"
        existing_rows_map[target_user_id] = clean_row
    else:
        if target_user_id in existing_rows_map:
            del existing_rows_map[target_user_id]
            action = "removed"
        else:
            action = "skipped_ineligible"

    # Write updated rows back
    updated_rows = list(existing_rows_map.values())
    write_dataset_and_provenance(updated_rows, output_dir=output_dir)

    return {
        "status": "success",
        "user_id": target_user_id,
        "is_eligible": is_eligible,
        "action": action,
        "reason": reason,
        "total_eligible_users": len(updated_rows),
        "synthetic_data_used": False
    }


def main():
    import asyncio
    from motor.motor_asyncio import AsyncIOMotorClient
    from dotenv import load_dotenv

    # Locate .env
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_file = os.path.join(root_dir, ".env")
    if os.path.exists(env_file):
        load_dotenv(dotenv_path=env_file)
    else:
        load_dotenv()

    mongo_uri = os.getenv("MONGODB_URI")
    if not mongo_uri:
        print("[Error] MONGODB_URI not found in environment.")
        sys.exit(1)

    async def run_sync():
        client = AsyncIOMotorClient(mongo_uri)
        db = client.get_database()
        print(f"[Dataset Sync] Connecting to MongoDB and extracting eligible real users...")
        ml_dir = os.path.dirname(os.path.abspath(__file__))
        result = await sync_real_training_dataset(db, output_dir=ml_dir)
        print(f"[Dataset Sync] Result:")
        print(f"  Total Eligible Real Users: {result['eligible_users_count']}")
        print(f"  Total Ineligible Users:   {result['ineligible_users_count']}")
        print(f"  CSV Snapshot Path:        {result['csv_path']}")
        print(f"  Provenance Path:          {result['provenance_path']}")
        print(f"  Synthetic Data Used:      {result['synthetic_data_used']}")
        print(f"  User IDs ({len(result['user_ids'])}): {result['user_ids']}")
        client.close()

    asyncio.run(run_sync())


if __name__ == "__main__":
    main()
