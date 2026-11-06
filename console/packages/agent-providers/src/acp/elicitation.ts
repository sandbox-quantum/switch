import type { UserInputQuestion } from '../events';
import type { AcpSelectedAnswer } from './hooks';

interface ElicitationChoice {
  const: string | number;
  title?: string;
}
interface ElicitationProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  oneOf?: ElicitationChoice[];
  anyOf?: ElicitationChoice[];
  items?: ElicitationProperty;
}
/**
 * `elicitation/create`, which an agent sends to ask questions as a form when
 * the client announces it can answer one: `agy acp` for its `ask_question`
 * tool, Kimi Code for its AskUserQuestion tool.
 */
export interface AcpElicitationRequest {
  sessionId?: string;
  toolCallId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: { properties?: Record<string, ElicitationProperty> };
}

type ElicitationValue = string | number | boolean;

/** The answers `property` offers, each with the value the schema takes for it. */
function choices(
  property: ElicitationProperty | undefined
): Array<{ value: ElicitationValue; label: string }> {
  const offered = property?.oneOf ?? property?.anyOf;
  if (offered)
    return offered.map((choice) => ({
      value: choice.const,
      label: choice.title ?? String(choice.const),
    }));
  if (property?.enum) return property.enum.map((value) => ({ value, label: String(value) }));
  if (property?.type === 'boolean')
    return [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ];
  return [];
}

/** One question a form elicitation asks, and the fields its answer fills. */
interface ElicitationField {
  question: UserInputQuestion;
  /** Option value as offered to the user → the value the schema takes. */
  values: Map<string, ElicitationValue>;
  /** The field typed text goes into, if any: the question's own, or its "Other". */
  textField?: { id: string; property: ElicitationProperty };
}

/**
 * The questions a form elicitation asks. A field with offered answers is one
 * question, choosing one of them or (an array field) several; the free-text
 * "Other" agy adds beside it as `<field>_other` becomes that question's own
 * typed answer. Any other free-text field is a question answered by typing.
 */
function elicitationFields(request: AcpElicitationRequest): ElicitationField[] {
  if (request.mode !== undefined && request.mode !== 'form') return [];
  const properties = request.requestedSchema?.properties ?? {};
  const offeredBy = (property: ElicitationProperty) =>
    choices(property.type === 'array' ? property.items : property);
  const freeText = (property: ElicitationProperty | undefined): property is ElicitationProperty =>
    property !== undefined && !offeredBy(property).length;
  return Object.entries(properties).flatMap(([id, property]): ElicitationField[] => {
    const base = id.endsWith('_other') ? properties[id.slice(0, -'_other'.length)] : undefined;
    if (freeText(property) && base && !freeText(base)) return [];
    const offered = offeredBy(property);
    const other = properties[`${id}_other`];
    const textField = !offered.length
      ? { id, property }
      : freeText(other)
        ? { id: `${id}_other`, property: other }
        : undefined;
    return [
      {
        question: {
          id,
          question:
            property.title ?? property.description ?? request.message ?? 'Choose an option.',
          options: offered.map((choice) => ({ value: String(choice.value), label: choice.label })),
          multiSelect: property.type === 'array' && offered.length > 0,
          allowCustomAnswer: Boolean(textField),
        },
        values: new Map(offered.map((choice) => [String(choice.value), choice.value])),
        ...(textField ? { textField } : {}),
      },
    ];
  });
}

export function elicitationQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  return elicitationFields(request).map((field) => field.question);
}

/** Typed text as the schema of the field it fills takes it. */
function typedValue(
  text: string,
  property: ElicitationProperty
): ElicitationValue | ElicitationValue[] {
  if (property.type === 'array')
    return [typedValue(text, property.items ?? {}) as ElicitationValue];
  if (property.type === 'number' || property.type === 'integer') {
    const number = Number(text);
    // Text that is no number is passed as typed, for the agent to refuse.
    return text.trim() && Number.isFinite(number) ? number : text;
  }
  return text;
}

/** The elicitation result for the answers given. */
export function elicitationAnswer(
  request: AcpElicitationRequest,
  selected: AcpSelectedAnswer[]
): { action: 'accept'; content: Record<string, ElicitationValue | ElicitationValue[]> } {
  const fields = new Map(elicitationFields(request).map((field) => [field.question.id, field]));
  const content: Record<string, ElicitationValue | ElicitationValue[]> = {};
  for (const { questionId, values, custom } of selected) {
    const field = fields.get(questionId);
    if (!field) continue;
    const chosen = values.map((value) => field.values.get(value) ?? value);
    if (field.question.multiSelect) {
      if (chosen.length) content[questionId] = chosen;
    } else if (chosen.length) content[questionId] = chosen[0]!;
    if (custom !== undefined && field.textField)
      content[field.textField.id] = typedValue(custom, field.textField.property);
  }
  return { action: 'accept', content };
}
