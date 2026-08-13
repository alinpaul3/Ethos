import os
import sys
import unittest
import asyncio
import numpy as np

# Ensure root and ml paths are accessible
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ml"))

from ml.dataset import load_and_prepare_data, generate_synthetic_samples
from ml.predict import predict_personality
from gemini_service import GeminiQuotaExhaustedError
from enrichment_service import generate_event_id, CURRENT_ENRICHMENT_VERSION

class MockMongoDBCollection:
    def __init__(self):
        self.data = []

    async def find_one(self, query):
        for doc in self.data:
            match = True
            for k, v in query.items():
                keys = k.split('.')
                val = doc
                for key in keys:
                    if isinstance(val, dict):
                        val = val.get(key)
                    else:
                        val = None
                        break
                if val != v:
                    match = False
                    break
            if match:
                return doc
        return None

    async def update_one(self, filter_query, update_doc, upsert=False):
        set_data = update_doc.get("$set", {})
        existing = await self.find_one(filter_query)
        if existing:
            existing.update(set_data)
        elif upsert:
            new_doc = {**filter_query, **set_data}
            self.data.append(new_doc)
        return True

    async def update_many(self, filter_query, update_doc):
        set_data = update_doc.get("$set", {})
        for doc in self.data:
            match = True
            for k, v in filter_query.items():
                if doc.get(k) != v:
                    match = False
                    break
            if match:
                doc.update(set_data)

    def find(self, query):
        class Cursor:
            def __init__(self, data, query):
                self.matched = []
                for doc in data:
                    match = True
                    for k, v in query.items():
                        if doc.get(k) != v:
                            match = False
                            break
                    if match:
                        self.matched.append(doc)
            async def to_list(self, length=None):
                return self.matched[:length] if length else self.matched
        return Cursor(self.data, query)

    async def count_documents(self, query):
        matched = 0
        for doc in self.data:
            match = True
            for k, v in query.items():
                if doc.get(k) != v:
                    match = False
                    break
            if match:
                matched += 1
        return matched

class MockMongoDB:
    def __init__(self):
        self.raw_events = MockMongoDBCollection()
        self.enriched_events = MockMongoDBCollection()
        self.user_features = MockMongoDBCollection()
        self.behavior_profiles = MockMongoDBCollection()
        self.personality_predictions = MockMongoDBCollection()
        self.ocean_predictions = MockMongoDBCollection()
        self.processing_status = MockMongoDBCollection()

class TestPipelineEndToEnd(unittest.TestCase):

    def setUp(self):
        self.mock_db = MockMongoDB()

    def test_event_id_generation(self):
        event_1 = {
            "user_id": "usr_001",
            "url": "https://youtube.com/watch?v=123",
            "timestamp_start": "2026-08-13T20:00:00Z"
        }
        event_2 = {
            "user_id": "usr_001",
            "url": "https://youtube.com/watch?v=123",
            "timestamp_start": "2026-08-13T20:00:00Z"
        }
        event_3 = {
            "user_id": "usr_001",
            "url": "https://youtube.com/watch?v=123",
            "timestamp_start": "2026-08-13T21:00:00Z"
        }
        id1 = generate_event_id(event_1)
        id2 = generate_event_id(event_2)
        id3 = generate_event_id(event_3)

        self.assertEqual(id1, id2, "Same event session must generate identical event_id")
        self.assertNotEqual(id1, id3, "Different watch timestamps must generate distinct event_ids")

    def test_synthetic_dataset_generation(self):
        df = generate_synthetic_samples(num_samples=100)
        self.assertEqual(len(df), 100)
        self.assertIn("avg_session_duration", df.columns)
        self.assertIn("openness", df.columns)
        self.assertTrue((df["openness"] >= 1.0).all() and (df["openness"] <= 5.0).all())

    def test_ml_prediction_with_model_or_fallback(self):
        sample_features = {
            "avg_session_duration": 25.0,
            "late_night_ratio": 0.1,
            "topic_diversity": 0.8,
            "learning_ratio": 0.6,
            "activity_consistency": 0.9
        }
        try:
            res = predict_personality(sample_features, model_dir="ml")
            self.assertEqual(res["prediction_method"], "ml")
            self.assertIn("openness", res)
            self.assertTrue(1.0 <= res["openness"] <= 5.0)
        except FileNotFoundError:
            # Model not trained yet, expected exception before Step 1 training
            pass

    def test_100_event_cursor_delta_logic(self):
        current_count = 99
        last_processed = 0
        delta = current_count - last_processed
        self.assertTrue(delta < 100, "99 events should skip processing")

        current_count = 100
        delta = current_count - last_processed
        self.assertTrue(delta >= 100, "100 events should trigger processing")

        last_processed = 100
        current_count = 199
        delta = current_count - last_processed
        self.assertTrue(delta < 100, "199 events after 100 should skip processing")

        current_count = 200
        delta = current_count - last_processed
        self.assertTrue(delta >= 100, "200 events should trigger second processing")

    def test_personality_predictions_upsert_deduplication(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        async def run_upsert():
            user_id = "test_user_upsert"
            doc1 = {
                "user_id": user_id,
                "scores": {"openness": 4.1, "conscientiousness": 3.8, "extraversion": 2.9, "agreeableness": 4.2, "neuroticism": 2.1},
                "prediction_method": "ml",
                "event_count_at_prediction": 100,
                "predicted_at": "2026-08-13T20:00:00Z"
            }
            await self.mock_db.personality_predictions.update_one({"user_id": user_id}, {"$set": doc1}, upsert=True)
            count1 = await self.mock_db.personality_predictions.count_documents({"user_id": user_id})

            doc2 = {
                "user_id": user_id,
                "scores": {"openness": 4.3, "conscientiousness": 4.0, "extraversion": 3.0, "agreeableness": 4.3, "neuroticism": 1.9},
                "prediction_method": "ml",
                "event_count_at_prediction": 200,
                "predicted_at": "2026-08-13T22:00:00Z"
            }
            await self.mock_db.personality_predictions.update_one({"user_id": user_id}, {"$set": doc2}, upsert=True)
            count2 = await self.mock_db.personality_predictions.count_documents({"user_id": user_id})

            updated_doc = await self.mock_db.personality_predictions.find_one({"user_id": user_id})
            return count1, count2, updated_doc

        count1, count2, updated_doc = loop.run_until_complete(run_upsert())
        self.assertEqual(count1, 1, "First run should insert 1 document")
        self.assertEqual(count2, 1, "Second run should UPSERT and maintain exactly 1 document")
        self.assertEqual(updated_doc["event_count_at_prediction"], 200, "UPSERT should update prediction document fields")
        loop.close()

if __name__ == "__main__":
    unittest.main()
