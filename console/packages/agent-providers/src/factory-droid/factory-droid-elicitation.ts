import {
  elicitationAnswer,
  elicitationQuestions,
  type AcpElicitationRequest,
} from '../acp/form-elicitation';
import type { AcpSelectedAnswer } from '../acp/hooks';
import type { UserInputQuestion } from '../events';

/** Droid's AskUser form, checked before handing an untrusted request to the mapper. */
function isDroidForm(params: unknown): params is AcpElicitationRequest {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const request = params as AcpElicitationRequest;
  if (request.mode !== undefined && request.mode !== 'form') return false;
  if (request.message !== undefined && typeof request.message !== 'string') return false;
  const properties = request.requestedSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  const validProperty = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const property = value as Record<string, unknown>;
    if (property.type !== undefined && typeof property.type !== 'string') return false;
    if (property.title !== undefined && typeof property.title !== 'string') return false;
    if (property.description !== undefined && typeof property.description !== 'string')
      return false;
    for (const key of ['oneOf', 'anyOf']) {
      const choices = property[key];
      if (
        choices !== undefined &&
        (!Array.isArray(choices) ||
          choices.some(
            (choice) =>
              !choice ||
              typeof choice !== 'object' ||
              Array.isArray(choice) ||
              !['string', 'number'].includes(typeof choice.const) ||
              (choice.title !== undefined && typeof choice.title !== 'string')
          ))
      )
        return false;
    }
    if (
      property.enum !== undefined &&
      (!Array.isArray(property.enum) ||
        property.enum.some((value) => !['string', 'number'].includes(typeof value)))
    )
      return false;
    return property.items === undefined || validProperty(property.items);
  };
  return Object.entries(properties).every(
    ([key, value]) =>
      !['__proto__', 'prototype', 'constructor'].includes(key) && validProperty(value)
  );
}

/** Map Droid's explicit Other choice onto Switch's custom-text input. */
export function droidQuestions(params: unknown): UserInputQuestion[] {
  if (!isDroidForm(params)) return [];
  const properties = params.requestedSchema!.properties!;
  return elicitationQuestions(params).map((question) => {
    const property = properties[question.id]!;
    const customChoice =
      question.allowCustomAnswer &&
      Boolean(properties[`${question.id}_other`]) &&
      question.options.some((option) => option.value === 'other');
    return {
      ...question,
      ...(property.title ? { header: property.title } : {}),
      question: property.description ?? property.title ?? params.message ?? question.question,
      options: customChoice
        ? question.options.filter((option) => option.value !== 'other')
        : question.options,
    };
  });
}

/** Droid requires the Other sentinel in addition to its companion text field. */
export function droidAnswer(
  request: AcpElicitationRequest,
  selected: AcpSelectedAnswer[]
): ReturnType<typeof elicitationAnswer> {
  const answer = elicitationAnswer(request, selected);
  const questions = elicitationQuestions(request);
  const properties = request.requestedSchema?.properties ?? {};
  for (const { questionId, custom } of selected) {
    const question = questions.find((candidate) => candidate.id === questionId);
    if (
      custom === undefined ||
      !properties[`${questionId}_other`] ||
      !question?.options.some((option) => option.value === 'other')
    )
      continue;
    const chosen = answer.content[questionId];
    answer.content[questionId] = question.multiSelect
      ? [...(Array.isArray(chosen) ? chosen : []), 'other']
      : 'other';
  }
  return answer;
}
