from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalResult,
    QuestionsContent,
    QuestionsResult,
    RequestContent,
    RequestResult,
)


def validate_answer(content: RequestContent, answer: RequestResult) -> None:
    if isinstance(content, ApprovalContent) and isinstance(answer, ApprovalResult):
        if any(option.option_id == answer.option_id for option in content.options):
            return
    elif isinstance(content, QuestionsContent) and isinstance(answer, QuestionsResult):
        answers = {a.question_id: a for a in answer.answers}
        if len(answers) != len(answer.answers) or set(answers) != {
            q.question_id for q in content.questions
        }:
            raise ValueError("INVALID_ANSWER: answer every question exactly once.")
        for question in content.questions:
            value = answers[question.question_id]
            selected = set(value.selected_option_ids)
            custom = bool(value.custom_text and value.custom_text.strip())
            if len(selected) != len(value.selected_option_ids) or not selected.issubset(
                {o.option_id for o in question.options}
            ):
                raise ValueError("INVALID_ANSWER: unknown or repeated option.")
            if custom and not question.allow_custom_answer:
                raise ValueError("INVALID_ANSWER: custom text is not allowed.")
            count = len(selected) + int(custom)
            if count == 0 or (not question.multi_select and count != 1):
                raise ValueError("INVALID_ANSWER: invalid selection count.")
        return
    raise ValueError("INVALID_ANSWER: answer is not an offered option.")
