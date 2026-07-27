import os
import json
import csv

def export_training_dataset():
    """
    Export training dataset from MongoDB/JSON into training_dataset.csv
    """
    output_file = "training_dataset.csv"
    headers = [
        "user_id",
        "avg_session_duration",
        "late_night_ratio",
        "topic_diversity",
        "learning_ratio",
        "activity_consistency",
        "openness",
        "conscientiousness",
        "extraversion",
        "agreeableness",
        "neuroticism"
    ]
    
    if os.path.exists(output_file):
        print(f"Dataset already generated at {output_file}")
    else:
        with open(output_file, mode="w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
        print(f"Initialized blank training dataset at {output_file}")

if __name__ == "__main__":
    export_training_dataset()