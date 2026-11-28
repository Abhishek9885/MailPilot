from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal, Self

from pydantic import Field, PostgresDsn, SecretStr, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../../.env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    service_name: str = Field(default="ai", validation_alias="AI_SERVICE_NAME")
    node_env: Literal["development", "test", "production"] = Field(
        default="development", validation_alias="NODE_ENV"
    )
    ai_host: str = Field(default="127.0.0.1", validation_alias="AI_HOST")
    ai_port: int = Field(default=8000, ge=1, le=65535, validation_alias="AI_PORT")
    ai_log_level: Literal["critical", "error", "warning", "info", "debug"] = Field(
        default="info", validation_alias="AI_LOG_LEVEL"
    )
    database_url: PostgresDsn | None = Field(default=None, validation_alias="DATABASE_URL")
    ai_database_url: PostgresDsn | None = Field(default=None, validation_alias="AI_DATABASE_URL")
    classifier_artifact_dir: Path | None = Field(
        default=None,
        validation_alias="AI_CLASSIFIER_ARTIFACT_DIR",
    )
    ai_internal_api_token: SecretStr | None = Field(
        default=None,
        min_length=32,
        validation_alias="AI_SERVICE_TOKEN",
    )
    llm_provider: Literal["openai"] = Field(default="openai", validation_alias="AI_LLM_PROVIDER")
    llm_model: str = Field(
        default="gpt-6.1-sol",
        min_length=1,
        max_length=128,
        validation_alias="AI_LLM_MODEL",
    )
    rag_context_token_budget: int = Field(
        default=12_000,
        ge=512,
        le=48_000,
        validation_alias="AI_RAG_CONTEXT_TOKEN_BUDGET",
    )
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    llm_timeout_seconds: float = Field(
        default=30.0, gt=0, le=120, validation_alias="AI_LLM_TIMEOUT_SECONDS"
    )
    llm_max_retries: int = Field(default=2, ge=0, le=4, validation_alias="AI_LLM_MAX_RETRIES")
    llm_max_retry_delay_seconds: float = Field(
        default=8.0,
        gt=0,
        le=60,
        validation_alias="AI_LLM_MAX_RETRY_DELAY_SECONDS",
    )
    llm_input_price_usd_per_mtok: Decimal | None = Field(
        default=None,
        ge=0,
        validation_alias="AI_LLM_INPUT_PRICE_USD_PER_MTOK",
    )
    llm_cached_input_price_usd_per_mtok: Decimal | None = Field(
        default=None,
        ge=0,
        validation_alias="AI_LLM_CACHED_INPUT_PRICE_USD_PER_MTOK",
    )
    llm_output_price_usd_per_mtok: Decimal | None = Field(
        default=None,
        ge=0,
        validation_alias="AI_LLM_OUTPUT_PRICE_USD_PER_MTOK",
    )
    llm_pricing_version: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        validation_alias="AI_LLM_PRICING_VERSION",
    )
    embedding_provider: Literal["openai"] = Field(
        default="openai", validation_alias="AI_EMBEDDING_PROVIDER"
    )
    embedding_model: Literal["text-embedding-3-small", "text-embedding-3-large"] = Field(
        default="text-embedding-3-small", validation_alias="AI_EMBEDDING_MODEL"
    )
    embedding_dimensions: int = Field(
        default=1_536, ge=1, le=3_072, validation_alias="AI_EMBEDDING_DIMENSIONS"
    )
    embedding_timeout_seconds: float = Field(
        default=30.0, gt=0, le=120, validation_alias="AI_EMBEDDING_TIMEOUT_SECONDS"
    )
    embedding_max_retries: int = Field(
        default=2, ge=0, le=4, validation_alias="AI_EMBEDDING_MAX_RETRIES"
    )
    embedding_max_retry_delay_seconds: float = Field(
        default=8.0,
        gt=0,
        le=60,
        validation_alias="AI_EMBEDDING_MAX_RETRY_DELAY_SECONDS",
    )
    embedding_input_price_usd_per_mtok: Decimal | None = Field(
        default=None,
        ge=0,
        validation_alias="AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK",
    )
    embedding_pricing_version: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        validation_alias="AI_EMBEDDING_PRICING_VERSION",
    )

    @model_validator(mode="after")
    def validate_provider_configuration(self) -> Self:
        if self.node_env == "production" and self.ai_database_url is None:
            raise ValueError("AI_DATABASE_URL is required in production")
        if self.ai_database_url is None and self.database_url is None:
            raise ValueError("AI_DATABASE_URL or DATABASE_URL is required")

        price_settings = (
            self.llm_input_price_usd_per_mtok,
            self.llm_output_price_usd_per_mtok,
            self.llm_pricing_version,
        )
        if any(value is not None for value in price_settings) and not all(
            value is not None for value in price_settings
        ):
            raise ValueError(
                "AI_LLM_INPUT_PRICE_USD_PER_MTOK, "
                "AI_LLM_OUTPUT_PRICE_USD_PER_MTOK, and "
                "AI_LLM_PRICING_VERSION must be configured together"
            )
        if self.llm_cached_input_price_usd_per_mtok is not None and not all(
            value is not None for value in price_settings
        ):
            raise ValueError(
                "AI_LLM_CACHED_INPUT_PRICE_USD_PER_MTOK requires "
                "input/output prices and a pricing version"
            )
        embedding_price_settings = (
            self.embedding_input_price_usd_per_mtok,
            self.embedding_pricing_version,
        )
        if any(value is not None for value in embedding_price_settings) and not all(
            value is not None for value in embedding_price_settings
        ):
            raise ValueError(
                "AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK and "
                "AI_EMBEDDING_PRICING_VERSION must be configured together"
            )
        model_max_dimensions = 1_536 if self.embedding_model == "text-embedding-3-small" else 3_072
        if self.embedding_dimensions > model_max_dimensions:
            raise ValueError(
                "AI_EMBEDDING_DIMENSIONS exceeds the configured embedding model dimensions"
            )
        return self

    @property
    def database_connection_url(self) -> PostgresDsn:
        configured_url = self.ai_database_url or self.database_url
        if configured_url is None:
            raise RuntimeError("AI_DATABASE_URL is required")
        return configured_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as error:
        fields_list: list[str] = []
        for item in error.errors():
            if item["loc"]:
                fields_list.append(str(item["loc"][0]))
                continue
            context = item.get("ctx", {})
            validator_error = context.get("error") if isinstance(context, dict) else None
            message = str(validator_error) if validator_error is not None else ""
            safe_name = next(
                (
                    name
                    for name in (
                        "AI_DATABASE_URL",
                        "AI_EMBEDDING_DIMENSIONS",
                        "AI_EMBEDDING_PRICING_CONFIGURATION",
                        "AI_LLM_PRICING_CONFIGURATION",
                    )
                    if name in message
                    or (
                        name == "AI_EMBEDDING_PRICING_CONFIGURATION"
                        and "AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK" in message
                    )
                ),
                "AI_LLM_PRICING_CONFIGURATION",
            )
            fields_list.append(safe_name)
        fields = ", ".join(dict.fromkeys(fields_list))
        raise RuntimeError(f"Invalid AI environment configuration: {fields}") from None
