import json

import pytest

from mailpilot_ai.llm.contracts import LLMRequest, LLMResponse
from mailpilot_ai.rag.planning import (
    IntentClassification,
    PlannedOperation,
    PlannedStep,
    RAGIntent,
    RAGIntentPlanningService,
    RAGPlanningOutputError,
    RAGRequestPlan,
)


class FakeLLMProvider:
    def __init__(self, outputs: list[dict[str, object]]) -> None:
        self.outputs = list(outputs)
        self.requests: list[LLMRequest] = []

    async def generate(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        output = self.outputs.pop(0)
        return LLMResponse(
            text=json.dumps(output),
            provider="test-provider",
            model="test-model-v1",
        )


def _classification(
    intent: RAGIntent = RAGIntent.EMAIL_SEARCH,
    confidence: float = 0.95,
) -> IntentClassification:
    return IntentClassification(intent=intent, confidence=confidence)


def _plan(intent: RAGIntent, *operations: PlannedOperation) -> RAGRequestPlan:
    return RAGRequestPlan(
        intent=intent,
        steps=tuple(PlannedStep(operation=operation) for operation in operations),
    )


@pytest.mark.anyio
async def test_planner_classifies_and_builds_allowlisted_email_search_plan() -> None:
    provider = FakeLLMProvider(
        [
            {"intent": "email_search", "confidence": 0.97},
            {"intent": "email_search", "steps": [{"operation": "search_emails"}]},
        ]
    )
    service = RAGIntentPlanningService(provider=provider)

    classification = await service.classify("Find the thread about invoice INV-42")
    plan = await service.create_plan(
        query="Find the thread about invoice INV-42",
        classification=classification,
    )

    assert classification.intent is RAGIntent.EMAIL_SEARCH
    assert service.validate_plan(classification, plan) == plan
    assert plan.steps[0].operation is PlannedOperation.SEARCH_EMAILS
    assert len(provider.requests) == 2
    assert "chain-of-thought" in provider.requests[0].messages[0].content
    assert "untrusted data" in provider.requests[0].messages[0].content
    assert "No loops" in provider.requests[1].messages[0].content


@pytest.mark.anyio
async def test_ambiguous_or_low_confidence_intent_uses_static_clarification() -> None:
    provider = FakeLLMProvider([{"intent": "ambiguous", "confidence": 0.2}])
    service = RAGIntentPlanningService(provider=provider)

    classification = await service.classify("Can you take care of this?")
    plan = await service.create_plan(
        query="Can you take care of this?",
        classification=classification,
    )

    assert classification.requires_clarification is True
    assert plan.intent is RAGIntent.AMBIGUOUS
    assert plan.steps == ()
    assert plan.clarification_question
    assert len(provider.requests) == 1


@pytest.mark.anyio
async def test_invalid_model_operation_is_rejected_before_any_execution() -> None:
    provider = FakeLLMProvider(
        [
            {"intent": "email_search", "confidence": 0.99},
            {"intent": "email_search", "steps": [{"operation": "send_email"}]},
        ]
    )
    service = RAGIntentPlanningService(provider=provider)
    classification = await service.classify("Find the invoice message")

    with pytest.raises(RAGPlanningOutputError):
        await service.create_plan(query="Find the invoice message", classification=classification)


def test_plan_must_match_intent_sequence_and_cannot_repeat_operations() -> None:
    provider = FakeLLMProvider([])
    service = RAGIntentPlanningService(provider=provider)
    classification = _classification(RAGIntent.SUMMARIZATION)

    invalid_order = _plan(
        RAGIntent.SUMMARIZATION,
        PlannedOperation.SUMMARIZE_EVIDENCE,
        PlannedOperation.SEARCH_EMAILS,
    )
    duplicate_step = _plan(
        RAGIntent.SUMMARIZATION,
        PlannedOperation.SEARCH_EMAILS,
        PlannedOperation.SUMMARIZE_EVIDENCE,
        PlannedOperation.SUMMARIZE_EVIDENCE,
    )

    with pytest.raises(RAGPlanningOutputError):
        service.validate_plan(classification, invalid_order)
    with pytest.raises(RAGPlanningOutputError):
        service.validate_plan(classification, duplicate_step)


def test_task_plan_allows_candidates_but_no_task_mutations() -> None:
    service = RAGIntentPlanningService(provider=FakeLLMProvider([]))
    classification = _classification(RAGIntent.TASK_OPERATION)
    allowed = _plan(
        RAGIntent.TASK_OPERATION,
        PlannedOperation.SEARCH_EMAILS,
        PlannedOperation.EXTRACT_ACTION_ITEMS,
        PlannedOperation.PROPOSE_TASK_CANDIDATES,
    )

    assert service.validate_plan(classification, allowed) == allowed
    with pytest.raises(ValueError):
        PlannedOperation("complete_task")


def test_plan_schema_caps_steps() -> None:
    with pytest.raises(ValueError):
        RAGRequestPlan.model_validate(
            {
                "intent": "email_search",
                "steps": [{"operation": "search_emails"}] * 6,
            }
        )
