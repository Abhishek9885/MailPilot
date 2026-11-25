import json
import re
import sys
from collections import Counter
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ROOT = Path(__file__).resolve().parents[3]
DATASET_PATH = ROOT / "eval" / "email-classification-v1.jsonl"
DATASET_VERSION = "email-classification-v1"

Category = Literal[
    "work",
    "personal",
    "finance",
    "travel",
    "shopping",
    "social",
    "newsletter",
    "security",
    "other",
]
Priority = Literal["low", "normal", "high", "urgent"]
Split = Literal["train", "validation", "test"]
CATEGORIES = (
    "work",
    "personal",
    "finance",
    "travel",
    "shopping",
    "social",
    "newsletter",
    "security",
    "other",
)


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class DatasetModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class DatasetEmail(DatasetModel):
    subject: str = Field(min_length=1, max_length=2_000)
    sender_name: str = Field(min_length=1, max_length=320)
    sender_email: str = Field(min_length=3, max_length=320)
    received_at: datetime
    body_text: str = Field(min_length=1, max_length=20_000)

    @field_validator("sender_email")
    @classmethod
    def sender_address_is_reserved(cls, value: str) -> str:
        if not value.rsplit("@", 1)[-1].lower().endswith(".invalid"):
            raise ValueError("synthetic sender addresses must use a reserved .invalid domain")
        return value

    @field_validator("received_at")
    @classmethod
    def received_time_is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("receivedAt must include a timezone")
        return value


class DatasetLabels(DatasetModel):
    primary_category: Category
    categories: list[Category] = Field(min_length=1, max_length=4)
    priority: Priority

    @model_validator(mode="after")
    def validate_category_labels(self) -> Self:
        if len(self.categories) != len(set(self.categories)):
            raise ValueError("categories must be unique")
        if self.categories[0] != self.primary_category:
            raise ValueError("primaryCategory must be the first category label")
        return self


class DatasetRecord(DatasetModel):
    id: str = Field(min_length=1, max_length=128)
    split: Split
    thread_id: str = Field(min_length=1, max_length=128)
    duplicate_group_id: str | None = Field(default=None, max_length=128)
    email: DatasetEmail
    labels: DatasetLabels


def _fingerprint(record: DatasetRecord) -> str:
    normalized = "\n".join(
        re.sub(r"\s+", " ", value).strip().casefold()
        for value in (
            record.email.sender_email,
            record.email.subject,
            record.email.body_text,
        )
    )
    return sha256(normalized.encode("utf-8")).hexdigest()


def load_records(dataset_path: Path = DATASET_PATH) -> list[DatasetRecord]:
    if not dataset_path.is_file():
        raise ValueError(f"dataset file is missing: {dataset_path}")

    records: list[DatasetRecord] = []
    for line_number, line in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            payload: object = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError(f"invalid JSON on dataset line {line_number}") from None
        try:
            records.append(DatasetRecord.model_validate(payload))
        except ValidationError as error:
            fields = sorted(
                {
                    ".".join(str(part) for part in item["loc"])
                    for item in error.errors(include_input=False)
                }
            )
            raise ValueError(
                f"invalid dataset record on line {line_number}; fields: {', '.join(fields)}"
            ) from None
    return records


def validate_records(records: list[DatasetRecord]) -> None:
    expected_split_counts = {"train": 18, "validation": 9, "test": 9}
    split_counts = Counter(record.split for record in records)
    if len(records) != 36 or split_counts != expected_split_counts:
        raise ValueError(f"unexpected dataset/split sizes: {dict(split_counts)}")

    ids: set[str] = set()
    thread_splits: dict[str, Split] = {}
    duplicate_group_splits: dict[str, Split] = {}
    fingerprints: dict[str, DatasetRecord] = {}
    primary_counts: Counter[str] = Counter()
    split_primary_counts: dict[str, Counter[str]] = {
        split: Counter() for split in expected_split_counts
    }
    category_counts: Counter[str] = Counter()
    priority_counts: Counter[str] = Counter()
    split_priority_counts: dict[str, Counter[str]] = {
        split: Counter() for split in expected_split_counts
    }

    for record in records:
        if record.id in ids:
            raise ValueError(f"duplicate record id: {record.id}")
        ids.add(record.id)

        prior_thread_split = thread_splits.setdefault(record.thread_id, record.split)
        if prior_thread_split != record.split:
            raise ValueError(f"thread crosses dataset splits: {record.thread_id}")
        if record.duplicate_group_id is not None:
            prior_duplicate_split = duplicate_group_splits.setdefault(
                record.duplicate_group_id, record.split
            )
            if prior_duplicate_split != record.split:
                raise ValueError(
                    f"duplicate group crosses dataset splits: {record.duplicate_group_id}"
                )

        content_fingerprint = _fingerprint(record)
        prior_duplicate = fingerprints.get(content_fingerprint)
        if prior_duplicate is not None:
            if prior_duplicate.split != record.split:
                raise ValueError("exact duplicate email content crosses dataset splits")
            if (
                prior_duplicate.duplicate_group_id is None
                or record.duplicate_group_id != prior_duplicate.duplicate_group_id
            ):
                raise ValueError("exact duplicate content must share a duplicateGroupId")
        else:
            fingerprints[content_fingerprint] = record

        primary_counts[record.labels.primary_category] += 1
        split_primary_counts[record.split][record.labels.primary_category] += 1
        category_counts.update(record.labels.categories)
        priority_counts[record.labels.priority] += 1
        split_priority_counts[record.split][record.labels.priority] += 1

    expected_categories = set(CATEGORIES)
    if set(primary_counts) != expected_categories or any(
        count != 4 for count in primary_counts.values()
    ):
        raise ValueError(f"primary category labels are not balanced: {dict(primary_counts)}")
    for split, counts in split_primary_counts.items():
        expected_count = 2 if split == "train" else 1
        if set(counts) != expected_categories or any(
            count != expected_count for count in counts.values()
        ):
            raise ValueError(f"primary categories are not balanced in {split}: {dict(counts)}")

    expected_priorities = {"low": 11, "normal": 11, "high": 8, "urgent": 6}
    if dict(priority_counts) != expected_priorities:
        raise ValueError(f"unexpected priority balance: {dict(priority_counts)}")
    expected_split_priorities = set(expected_priorities)
    for split, counts in split_priority_counts.items():
        if set(counts) != expected_split_priorities:
            raise ValueError(f"priority classes are missing from {split}: {dict(counts)}")

    if any(count < 1 for count in split_counts.values()):
        raise ValueError("all declared splits must contain records")

    print(f"Valid {DATASET_VERSION}: {len(records)} synthetic records")
    print("Split counts:", dict(split_counts))
    print("Primary category counts:", dict(primary_counts))
    print("Category membership counts:", dict(category_counts))
    print("Priority counts:", dict(priority_counts))
    for split, counts in split_priority_counts.items():
        print(f"{split.title()} priority counts:", dict(counts))
    print(f"Unique thread IDs: {len(thread_splits)}")
    print(f"Unique duplicate groups: {len(duplicate_group_splits)}")


def main() -> int:
    try:
        records = load_records()
        validate_records(records)
    except ValueError as error:
        print(f"Dataset validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
