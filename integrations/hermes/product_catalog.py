"""Read the Thu Ha Authentic Web App product catalog as the source of truth.

The POS Web App `Products` sheet owns live product names, prices, stock, visibility,
usage and images. Messenger keeps its queue in Fast Index, but all product advice
is overlaid with this read-only source instead of relying on PRODUCTS_HOT cache.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

POS_SPREADSHEET_ID = os.getenv(
    "THA_POS_SPREADSHEET_ID",
    "1doVqvBOq0sn7mQ3LgfAuZfvfjW08jIWdvswgYTwiY-s",
).strip()
POS_PRODUCTS_RANGE = os.getenv(
    "THA_POS_PRODUCTS_RANGE",
    "Products!A1:AN2000",
).strip()
PRODUCT_SOURCE_MODE = os.getenv(
    "THA_PRODUCT_SOURCE_MODE",
    "AUTO",
).strip().upper()
DEFAULT_CREDENTIALS_PATH = Path(
    os.getenv(
        "GOOGLE_APPLICATION_CREDENTIALS",
        "/opt/data/google/application_default_credentials.json",
    )
)


class ReadOnlyProductCatalog:
    """Google Sheets reader constrained to the spreadsheets.readonly scope."""

    def __init__(
        self,
        spreadsheet_id: str = POS_SPREADSHEET_ID,
        products_range: str = POS_PRODUCTS_RANGE,
    ) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
        )
        self.service = build(
            "sheets",
            "v4",
            credentials=credentials,
            cache_discovery=False,
        )
        self.spreadsheet_id = spreadsheet_id
        self.products_range = products_range

    def read_product_values(self) -> list[list[str]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(
                spreadsheetId=self.spreadsheet_id,
                range=self.products_range,
            )
            .execute()
        )
        return result.get("values", [])


def should_use_pos_source() -> bool:
    if PRODUCT_SOURCE_MODE == "POS_WEBAPP":
        return True
    if PRODUCT_SOURCE_MODE in {"FAST_INDEX", "CACHE"}:
        return False
    # AUTO preserves local/CI fake repositories while production installer sets
    # POS_WEBAPP explicitly. Existing host credentials are also a safe signal.
    return DEFAULT_CREDENTIALS_PATH.is_file()


class ProductCatalogOverlayRepository:
    """Delegate queue writes but replace PRODUCTS_HOT reads with POS Products."""

    def __init__(
        self,
        queue_repository: object,
        catalog_factory: Callable[[], ReadOnlyProductCatalog] = ReadOnlyProductCatalog,
    ) -> None:
        self.queue_repository = queue_repository
        self.catalog_factory = catalog_factory
        self._product_values: list[list[str]] | None = None

    def read(self, range_name: str) -> list[list[str]]:
        if str(range_name).startswith("PRODUCTS_HOT"):
            if self._product_values is None:
                self._product_values = self.catalog_factory().read_product_values()
            if not self._product_values:
                raise RuntimeError("POS Web App Products returned no rows")
            return self._product_values
        return self.queue_repository.read(range_name)

    def update_status(self, row_number: int, status: str, error: str = "") -> None:
        self.queue_repository.update_status(row_number, status, error)

    def update_reply(self, row_number: int, decision: object) -> None:
        self.queue_repository.update_reply(row_number, decision)


def overlay_source_of_truth(queue_repository: object) -> object:
    if not should_use_pos_source():
        return queue_repository
    return ProductCatalogOverlayRepository(queue_repository)
