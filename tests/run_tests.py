import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_pipeline_end_to_end import TestPipelineEndToEnd

if __name__ == "__main__":
    suite = unittest.TestLoader().loadTestsFromTestCase(TestPipelineEndToEnd)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("ALL TESTS PASSED SUCCESSFULLY!")
        sys.exit(0)
    else:
        print("TEST FAILURES DETECTED")
        sys.exit(1)
