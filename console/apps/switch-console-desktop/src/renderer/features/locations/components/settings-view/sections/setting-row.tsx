import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';

/**
 * One row of an agent page's General settings: what it is, an info tooltip,
 * a muted line saying what it does, and its control on the right.
 */
export function SettingRow({
  title,
  info,
  description,
  control,
  children,
}: {
  title: React.ReactNode;
  info: { label: string; content: React.ReactNode } | null;
  description: React.ReactNode;
  /** Null when the row's controls are below it, in `children`. */
  control: React.ReactNode;
  /** Anything under the description, such as an error or one control per agent. */
  children?: React.ReactNode;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldTitle>
          <span className="flex items-center gap-1.5">
            {title}
            {info && <InfoTooltip label={info.label} content={info.content} />}
          </span>
        </FieldTitle>
        {control}
      </div>
      <FieldDescription className="text-foreground-muted">{description}</FieldDescription>
      {children}
    </Field>
  );
}
