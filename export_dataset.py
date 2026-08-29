#!/usr/bin/env python3
"""
CLI entrypoint to export real training dataset from MongoDB to ml/training_dataset.csv.
"""
import sys
import os

# Ensure root and ml directories are on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml"))

from ml.export_real_dataset import main

if __name__ == "__main__":
    main()
