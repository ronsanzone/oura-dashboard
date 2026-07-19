import tempfile
import unittest
from pathlib import Path

from oura_dashboard.db import connect, initialize, load_records, record_counts, upsert_records
from oura_dashboard.demo import seed_demo
from oura_dashboard.metrics import daily_frame


class DataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tmp.name) / "test.db")
        initialize(self.connection)

    def tearDown(self):
        self.connection.close()
        self.tmp.cleanup()

    def test_upsert_is_idempotent(self):
        upsert_records(self.connection, "daily_sleep", [{"id": "a", "day": "2026-01-01", "score": 70}])
        upsert_records(self.connection, "daily_sleep", [{"id": "a", "day": "2026-01-01", "score": 80}])
        rows = load_records(self.connection, "daily_sleep")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["score"], 80)

    def test_demo_data_builds_daily_metrics(self):
        seed_demo(self.connection, days=10)
        counts = record_counts(self.connection)
        self.assertEqual(counts["daily_sleep"], 10)
        metrics = daily_frame(load_records(self.connection))
        self.assertEqual(len(metrics), 10)
        self.assertIn("Average HRV", metrics.columns)
        self.assertGreater(metrics["Total sleep"].mean(), 5)


if __name__ == "__main__":
    unittest.main()

