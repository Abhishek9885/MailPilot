import pytest

from mailpilot_ai.config import get_settings


def test_invalid_settings_report_variable_names_without_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_PORT", "70000")
    get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="AI_PORT") as error:
            get_settings()
        assert "70000" not in str(error.value)
    finally:
        get_settings.cache_clear()


def test_partial_llm_price_configuration_reports_a_safe_configuration_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_LLM_INPUT_PRICE_USD_PER_MTOK", "2.50")
    monkeypatch.delenv("AI_LLM_OUTPUT_PRICE_USD_PER_MTOK", raising=False)
    monkeypatch.delenv("AI_LLM_PRICING_VERSION", raising=False)
    get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="AI_LLM_PRICING_CONFIGURATION") as error:
            get_settings()
        assert "2.50" not in str(error.value)
    finally:
        get_settings.cache_clear()


def test_llm_retry_limits_are_validated_without_echoing_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_LLM_MAX_RETRIES", "9")
    get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="AI_LLM_MAX_RETRIES") as error:
            get_settings()
        assert "9" not in str(error.value)
    finally:
        get_settings.cache_clear()


def test_embedding_dimensions_must_fit_the_selected_model_without_echoing_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_EMBEDDING_MODEL", "text-embedding-3-small")
    monkeypatch.setenv("AI_EMBEDDING_DIMENSIONS", "2048")
    get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="AI_EMBEDDING_DIMENSIONS") as error:
            get_settings()
        assert "2048" not in str(error.value)
    finally:
        get_settings.cache_clear()


def test_partial_embedding_price_configuration_reports_a_safe_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK", "0.02")
    monkeypatch.delenv("AI_EMBEDDING_PRICING_VERSION", raising=False)
    get_settings.cache_clear()

    try:
        with pytest.raises(RuntimeError, match="AI_EMBEDDING_PRICING_CONFIGURATION") as error:
            get_settings()
        assert "0.02" not in str(error.value)
    finally:
        get_settings.cache_clear()
