"""Reading a model server's answer back into a choice, and the threshold step.

Part of the base package (pydantic only), with `prompt.py` and `models.py`:
switch-core renders the same prompt, reads the same answer and applies the
same threshold when it asks a model served on a user's own machine, so a
decision there is made exactly as the service would make it.
"""

import json
import math
from dataclasses import dataclass

from switch_decision.prompt import NONE, PICK_TOOL, SPEAKER_QUESTION

# How sure the model must be of an agent for the decision to name it.
DEFAULT_CONFIDENCE_THRESHOLD = 0.6


class ModelServerError(Exception):
    """The model server could not be reached or gave an answer we cannot use.

    `log_text` is what the service logs: the same as the message, minus anything
    the backend sent back (an error body could echo room content)."""

    def __init__(self, message: str, log_text: str | None = None):
        super().__init__(message)
        self.log_text = log_text if log_text is not None else message


class InvalidChoiceError(ModelServerError):
    """The model answered, but named something that is not one of the options.

    The API turns this into "no agent" rather than a failure: the backend worked,
    its answer just can't be routed."""

    def __init__(self, choice: object, confidence: float = 0.0):
        super().__init__(f"model chose {choice!r}, which is not one of the options")
        self.choice = str(choice)
        self.confidence = confidence


def _confidence_of(value: object) -> float:
    try:
        c = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return c if 0.0 <= c <= 1.0 else 0.0


@dataclass(frozen=True)
class ModelAnswer:
    choice: str
    confidence: float
    reason: str


def picked(answer: ModelAnswer, threshold: float) -> str | None:
    """The agent a decision names: the model's choice, unless it chose none
    or is less sure of it than `threshold`."""
    if answer.choice == NONE or answer.confidence < threshold:
        return None
    return answer.choice


def read_systemone(body: object, options: list[str]) -> ModelAnswer:
    """Map a SystemOne response to a choice and the chosen option's probability."""
    try:
        answer = body["answers"][SPEAKER_QUESTION]  # type: ignore[index]
        choice = answer["choice"]
        probabilities = answer.get("probabilities") or {}
    except (KeyError, TypeError) as exc:
        raise ModelServerError(
            f"SystemOne response has no '{SPEAKER_QUESTION}' answer"
        ) from exc
    if choice not in options:
        raise InvalidChoiceError(
            choice, _confidence_of(probabilities.get(choice, answer.get("confidence")))
        )
    confidence = probabilities.get(choice, answer.get("confidence"))
    if not isinstance(confidence, (int, float)):
        raise ModelServerError(f"SystemOne response has no probability for {choice!r}")
    top = sorted(probabilities.items(), key=lambda kv: kv[1], reverse=True)[:3]
    reason = (
        "probabilities: " + ", ".join(f"{k}={v:.2f}" for k, v in top) if top else ""
    )
    return ModelAnswer(choice=choice, confidence=float(confidence), reason=reason)


def read_ollama(body: object, options: list[str]) -> ModelAnswer:
    try:
        content = body["message"]["content"]  # type: ignore[index]
        out = json.loads(content)
        choice, confidence, reason = (
            out["agent"],
            float(out["confidence"]),
            out.get("reason", ""),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelServerError("Ollama output was not the expected JSON") from exc
    if choice not in options:
        raise InvalidChoiceError(choice, _confidence_of(confidence))
    return ModelAnswer(choice=choice, confidence=confidence, reason=reason)


def read_bedrock(body: dict, options: list[str]) -> ModelAnswer:
    """Map a Converse response whose message calls the pick tool."""
    try:
        blocks = body["output"]["message"]["content"]
        call = next(
            b["toolUse"]
            for b in blocks
            if "toolUse" in b and b["toolUse"]["name"] == PICK_TOOL
        )
        out = call["input"]
        choice, confidence, reason = (
            out["agent"],
            float(out["confidence"]),
            out.get("reason", ""),
        )
    except (KeyError, TypeError, ValueError, StopIteration) as exc:
        raise ModelServerError(
            "Bedrock response did not call the pick tool with a decision"
        ) from exc
    if choice not in options:
        raise InvalidChoiceError(choice, _confidence_of(confidence))
    if not 0.0 <= confidence <= 1.0:
        raise ModelServerError(f"model gave confidence {confidence}, outside 0 to 1")
    return ModelAnswer(choice=choice, confidence=confidence, reason=reason)


def read_letter_logprobs(body: dict, options: dict[str, str]) -> ModelAnswer:
    """Probabilities over the option letters from the first token's top logprobs,
    renormalised over the letters that are options."""
    try:
        top = body["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelServerError(
            "llama.cpp response has no top logprobs for the first token"
        ) from exc
    mass: dict[str, float] = {}
    try:
        for t in top:
            letter = t["token"].strip()
            if letter in options:
                mass[letter] = mass.get(letter, 0.0) + math.exp(t["logprob"])
    except (KeyError, TypeError, AttributeError) as exc:
        raise ModelServerError(
            "llama.cpp response's top logprobs are not tokens with logprobs"
        ) from exc
    total = sum(mass.values())
    if total <= 0:
        raise ModelServerError("the model put no probability on any option letter")
    probs = {options[k]: v / total for k, v in mass.items()}
    choice = max(probs, key=lambda name: probs[name])
    ranked = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return ModelAnswer(
        choice=choice,
        confidence=probs[choice],
        reason="probabilities: " + ", ".join(f"{k}={v:.2f}" for k, v in ranked),
    )
