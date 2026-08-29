import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_pipeline_end_to_end import TestPipelineEndToEnd
from test_timestamp_and_title_fixes import TestTimestampAndTitleFixes
from test_training_lifecycle import (
    TestEligibilityRules,
    TestDatasetSynchronizationAndIdempotency,
    TestNoSyntheticData,
    TestCrossValidationAndDataLeakage,
    TestSafeCandidateTrainingAndPromotion
)

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(TestPipelineEndToEnd))
    suite.addTests(loader.loadTestsFromTestCase(TestTimestampAndTitleFixes))
    suite.addTests(loader.loadTestsFromTestCase(TestEligibilityRules))
    suite.addTests(loader.loadTestsFromTestCase(TestDatasetSynchronizationAndIdempotency))
    suite.addTests(loader.loadTestsFromTestCase(TestNoSyntheticData))
    suite.addTests(loader.loadTestsFromTestCase(TestCrossValidationAndDataLeakage))
    suite.addTests(loader.loadTestsFromTestCase(TestSafeCandidateTrainingAndPromotion))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("\nALL PROJECT TESTS PASSED SUCCESSFULLY!")
        sys.exit(0)
    else:
        print("\nTEST FAILURES DETECTED")
        sys.exit(1)
