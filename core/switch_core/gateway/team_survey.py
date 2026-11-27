"""The "Tell us about your team" questions, which each person answers once
where the dashboard onboards people (`gateway_onboarding`).

The choices live here and nowhere else: the dashboard draws the questions from
`GET /auth/me/team-survey`, and an answer that is not one of them is refused.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import AfterValidator, BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session, get_user_store

router = APIRouter()

COMPANY_SIZES = ("1-10", "11-50", "51-200", "201-1,000", "1,000+")
ROLES = (
    "AI / ML Engineer",
    "Platform / DevOps",
    "Engineering Leader",
    "Security / Compliance",
    "Other",
)
AGENT_COUNTS = ("1-5", "6-20", "21-50", "51-100", "100+")
USE_CASES = (
    "Coding agents for my team",
    "Agents in Slack or Teams",
    "Automating workflows",
    "Support and triage",
    "Internal tools",
    "Other",
)


def _one_of(choices: tuple[str, ...]) -> Callable[[str], str]:
    def check(value: str) -> str:
        if value not in choices:
            raise ValueError(f"must be one of: {', '.join(choices)}")
        return value

    return check


def _distinct_use_cases(values: list[str]) -> list[str]:
    for value in values:
        _one_of(USE_CASES)(value)
    if len(set(values)) != len(values):
        raise ValueError("lists a use case twice")
    return values


class TeamSurveyAnswers(BaseModel):
    company_size: Annotated[str, AfterValidator(_one_of(COMPANY_SIZES))]
    role: Annotated[str, AfterValidator(_one_of(ROLES))]
    agent_count: Annotated[str, AfterValidator(_one_of(AGENT_COUNTS))]
    use_cases: Annotated[
        list[str], Field(min_length=1), AfterValidator(_distinct_use_cases)
    ]


class TeamSurveyChoices(BaseModel):
    company_size: list[str]
    role: list[str]
    agent_count: list[str]
    use_cases: list[str]


class TeamSurveyView(BaseModel):
    choices: TeamSurveyChoices
    answers: TeamSurveyAnswers | None
    answered_at: datetime | None


def _view(user: User) -> TeamSurveyView:
    return TeamSurveyView(
        choices=TeamSurveyChoices(
            company_size=list(COMPANY_SIZES),
            role=list(ROLES),
            agent_count=list(AGENT_COUNTS),
            use_cases=list(USE_CASES),
        ),
        # Read back unchecked: a choice retired since it was given stays as given.
        answers=None
        if user.team_survey is None
        else TeamSurveyAnswers.model_construct(**user.team_survey),
        answered_at=user.team_survey_answered_at,
    )


@router.get("/auth/me/team-survey")
async def my_team_survey(
    user: Annotated[User, Depends(get_current_user)],
) -> TeamSurveyView:
    """The questions, and the signed-in person's answers if they gave them."""
    return _view(user)


@router.put("/auth/me/team-survey")
async def answer_team_survey(
    answers: TeamSurveyAnswers,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> TeamSurveyView:
    """Keep the signed-in person's answers, replacing any given before."""
    await user_store.record_team_survey(session, user, answers.model_dump())
    await session.commit()
    return _view(user)
