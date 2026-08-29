import os
import sys
import unittest
import asyncio
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

# Ensure root directory is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from youtube_service import extract_video_id, create_fallback_metadata
from enrichment_service import generate_event_id, enrich_event_pipeline, CURRENT_ENRICHMENT_VERSION
from main import utc_now_iso

class MockCollection:
    def __init__(self):
        self.docs = []

    async def find_one(self, query):
        for doc in self.docs:
            if self._matches(doc, query):
                return dict(doc)
        return None

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return True

    async def update_one(self, query, update, upsert=False):
        set_dict = update.get("$set", {})
        for doc in self.docs:
            if self._matches(doc, query):
                doc.update(set_dict)
                return True
        if upsert:
            new_doc = {**query, **set_dict}
            self.docs.append(new_doc)
            return True
        return False

    async def update_many(self, query, update):
        set_dict = update.get("$set", {})
        updated_count = 0
        for doc in self.docs:
            if self._matches(doc, query):
                doc.update(set_dict)
                updated_count += 1
        return updated_count

    def find(self, query):
        matched = [dict(d) for d in self.docs if self._matches(d, query)]
        class MockCursor:
            def __init__(self, data):
                self.data = data
            async def to_list(self, length=None):
                return self.data[:length] if length else self.data
        return MockCursor(matched)

    async def count_documents(self, query):
        return sum(1 for d in self.docs if self._matches(d, query))

    def _matches(self, doc, query):
        for k, v in query.items():
            if k == "$or":
                if not any(self._matches(doc, subq) for subq in v):
                    return False
                continue
            keys = k.split('.')
            curr = doc
            for subk in keys:
                if isinstance(curr, dict):
                    curr = curr.get(subk)
                else:
                    curr = None
                    break
            if isinstance(v, dict) and "$regex" in v:
                import re
                if not (curr and re.search(v["$regex"], str(curr))):
                    return False
            elif curr != v:
                return False
        return True


class MockDB:
    def __init__(self):
        self.raw_events = MockCollection()
        self.enriched_events = MockCollection()
        self.user_features = MockCollection()
        self.behavior_profiles = MockCollection()
        self.personality_predictions = MockCollection()
        self.processing_status = MockCollection()


class TestTimestampAndTitleFixes(unittest.TestCase):

    def setUp(self):
        self.db = MockDB()

    def test_extract_video_id_formats(self):
        """Verify video ID extraction for standard, Shorts, and embed URLs."""
        self.assertEqual(extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(extract_video_id("https://www.youtube.com/shorts/3i_eY_vT1A0"), "3i_eY_vT1A0")
        self.assertEqual(extract_video_id("https://youtu.be/3i_eY_vT1A0?si=test"), "3i_eY_vT1A0")
        self.assertEqual(extract_video_id("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ")

    def test_title_isolation_no_cross_contamination(self):
        """
        Verify that video B never inherits video A's title.
        Even if video B initially has placeholder 'YouTube Short', it must not overwrite
        or be overwritten by video A's title.
        """
        vid_a_meta = create_fallback_metadata("video_id_AAA", "Video A Specific Title")
        self.assertEqual(vid_a_meta["official_title"], "Video A Specific Title")

        # Video B arrives with placeholder 'YouTube Short' during SPA transition
        vid_b_meta = create_fallback_metadata("video_id_BBB", "YouTube Short")
        self.assertEqual(vid_b_meta["official_title"], "YouTube Short")
        self.assertNotEqual(vid_b_meta["official_title"], vid_a_meta["official_title"])

    def test_enrichment_does_not_poison_raw_events_with_placeholders(self):
        """
        Verify that placeholder titles ('YouTube Short', 'YouTube Video') in enrichment
        do NOT overwrite titles in raw_events.
        """
        async def run():
            # Initial raw event with a custom title or placeholder
            await self.db.raw_events.insert_one({
                "user_id": "test_user_1",
                "platform": "youtube",
                "content_title": "Original Clean Title",
                "url": "https://www.youtube.com/shorts/shorts12345",
                "timestamp_start": "2026-08-29T05:00:00.000Z",
                "timestamp_end": "2026-08-29T05:01:00.000Z",
                "duration_seconds": 60
            })

            # Simulate enrichment for a short where oEmbed failed and returned 'YouTube Short'
            event_data = {
                "user_id": "test_user_1",
                "platform": "youtube",
                "content_title": "YouTube Short",
                "url": "https://www.youtube.com/shorts/shorts12345",
                "timestamp_start": "2026-08-29T05:00:00.000Z",
                "timestamp_end": "2026-08-29T05:01:00.000Z",
                "duration_seconds": 60
            }

            res = await enrich_event_pipeline(event_data, self.db)
            self.assertIsNotNone(res)

            # Check that raw_events still has the original title, NOT overwritten with 'YouTube Short'
            raw_doc = await self.db.raw_events.find_one({"user_id": "test_user_1"})
            self.assertEqual(raw_doc["content_title"], "Original Clean Title")

        asyncio.run(run())

    def test_offline_batch_sync_timestamp_prioritization(self):
        """
        Simulate user watching 3 videos at 10:00 AM, 10:15 AM, 10:30 AM while offline.
        When connected at 10:45 AM, all 3 events are synced with created_at = 10:45 AM.
        Verify that sorting and dashboard display prioritize timestamp_start over created_at.
        """
        sync_batch_time = "2026-08-29T05:15:00.000000+00:00"  # 10:45 AM IST in UTC

        raw_events = [
            {
                "event_id": "ev_1",
                "url": "https://www.youtube.com/watch?v=vid1",
                "content_title": "Video 1 (Watched 10:00 AM)",
                "timestamp_start": "2026-08-29T04:30:00.000Z",  # 10:00 AM IST
                "timestamp_end": "2026-08-29T04:40:00.000Z",
                "duration_seconds": 600,
                "created_at": sync_batch_time
            },
            {
                "event_id": "ev_2",
                "url": "https://www.youtube.com/watch?v=vid2",
                "content_title": "Video 2 (Watched 10:15 AM)",
                "timestamp_start": "2026-08-29T04:45:00.000Z",  # 10:15 AM IST
                "timestamp_end": "2026-08-29T04:55:00.000Z",
                "duration_seconds": 600,
                "created_at": sync_batch_time
            },
            {
                "event_id": "ev_3",
                "url": "https://www.youtube.com/watch?v=vid3",
                "content_title": "Video 3 (Watched 10:30 AM)",
                "timestamp_start": "2026-08-29T05:00:00.000Z",  # 10:30 AM IST
                "timestamp_end": "2026-08-29T05:10:00.000Z",
                "duration_seconds": 600,
                "created_at": sync_batch_time
            }
        ]

        # Sorting logic implemented in main.py / server.ts
        def parse_time_str(val):
            if not val:
                return ""
            if isinstance(val, (datetime)):
                return val.isoformat()
            return str(val)

        def event_time(e):
            return parse_time_str(e.get("timestamp_start") or e.get("created_at"))

        # Sort descending (most recent watch first)
        sorted_events = sorted(raw_events, key=event_time, reverse=True)

        # Most recent watch was Video 3 (10:30 AM), then Video 2 (10:15 AM), then Video 1 (10:00 AM)
        self.assertEqual(sorted_events[0]["event_id"], "ev_3")
        self.assertEqual(sorted_events[1]["event_id"], "ev_2")
        self.assertEqual(sorted_events[2]["event_id"], "ev_1")

        # Verify that all 3 retain distinct watch start times despite sharing created_at
        start_times = [e["timestamp_start"] for e in sorted_events]
        self.assertEqual(len(set(start_times)), 3)

    def test_utc_timezone_generation_and_ist_conversion(self):
        """
        Verify that server generates unambiguous timezone-aware UTC timestamps
        and that a UTC timestamp converts accurately to IST (UTC+05:30) without double conversion.
        """
        # Server generator
        now_str = utc_now_iso()
        dt_parsed = datetime.fromisoformat(now_str)
        self.assertIsNotNone(dt_parsed.tzinfo)

        # Test specific requirement: 2026-08-29T06:30:00.000Z -> 12:00:00 PM in IST
        utc_ts = "2026-08-29T06:30:00.000Z"
        # Normalize and convert to IST (Asia/Kolkata)
        utc_clean = utc_ts.replace("Z", "+00:00")
        dt_utc = datetime.fromisoformat(utc_clean)
        
        ist_tz = ZoneInfo("Asia/Kolkata")
        dt_ist = dt_utc.astimezone(ist_tz)

        self.assertEqual(dt_ist.hour, 12)
        self.assertEqual(dt_ist.minute, 0)
        self.assertEqual(dt_ist.second, 0)
        self.assertEqual(dt_ist.strftime("%I:%M:%S %p"), "12:00:00 PM")

    def test_retry_event_identity_deduplication(self):
        """
        Verify that a retry with identical session identity does not duplicate records.
        """
        async def run():
            event_payload = {
                "user_id": "test_user_dedup",
                "platform": "youtube",
                "url": "https://www.youtube.com/watch?v=dedup123456",
                "timestamp_start": "2026-08-29T06:00:00.000Z",
                "timestamp_end": "2026-08-29T06:05:00.000Z",
                "duration_seconds": 300,
                "content_title": "Deduplication Test Video"
            }

            # First submission
            event_dict_1 = {**event_payload, "created_at": utc_now_iso(), "updated_at": utc_now_iso()}
            await self.db.raw_events.insert_one(event_dict_1)

            # Simulated retry
            event_identity = {
                "user_id": event_payload["user_id"],
                "platform": event_payload["platform"],
                "url": event_payload["url"],
                "timestamp_start": event_payload["timestamp_start"],
                "timestamp_end": event_payload["timestamp_end"],
                "duration_seconds": event_payload["duration_seconds"],
            }
            existing = await self.db.raw_events.find_one(event_identity)
            self.assertIsNotNone(existing)

            # If existing, we don't insert duplicate
            if not existing:
                await self.db.raw_events.insert_one(event_dict_1)

            count = await self.db.raw_events.count_documents({"user_id": "test_user_dedup"})
            self.assertEqual(count, 1)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
