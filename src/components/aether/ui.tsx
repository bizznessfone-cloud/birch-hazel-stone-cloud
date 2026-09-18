import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export const fieldClass =
  "min-h-12 w-full border border-line bg-surface px-3 text-base text-ink outline-none transition-[border-color] duration-150 focus:border-ink";

export const guestFieldClass =
  "min-h-14 w-full border border-line bg-surface px-4 text-lg text-ink outline-none transition-[border-color] duration-150 focus:border-ink";

export const compactButtonClass =
  "inline-flex min-h-11 shrink-0 items-center justify-center border border-line bg-surface px-3 text-sm font-medium text-ink disabled:opacity-40";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium tracking-widest text-muted uppercase">{children}</p>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-3xl font-semibold tracking-tight">{children}</h1>;
}

export function PageLead({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{children}</p>;
}

export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
}) {
  return (
    <div>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1 className={`${eyebrow ? "mt-1" : ""} text-3xl font-semibold tracking-tight`}>{title}</h1>
      {lead ? <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{lead}</p> : null}
    </div>
  );
}

export function PrimaryButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase transition-opacity duration-150 disabled:opacity-40 ${className ?? ""}`}
    />
  );
}

export function GuestPrimaryButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`min-h-14 w-full bg-ink px-4 text-base font-semibold tracking-wide text-canvas uppercase transition-opacity duration-150 disabled:opacity-40 ${className ?? ""}`}
    />
  );
}

export function SecondaryButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`min-h-12 w-full border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-150 disabled:opacity-40 ${className ?? ""}`}
    />
  );
}

export function GuestSecondaryButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`min-h-14 w-full border border-line bg-surface px-4 text-base font-medium text-ink disabled:opacity-40 ${className ?? ""}`}
    />
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="border border-line bg-surface px-4 py-3 text-sm leading-relaxed">{children}</p>
  );
}

export function EmptyState({ title, note }: { title: string; note?: string }) {
  return (
    <div className="border border-line bg-surface px-4 py-6">
      <p className="text-sm font-medium">{title}</p>
      {note ? <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p> : null}
    </div>
  );
}

export function StatusChip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "attention" | "live" | "cancelled";
  children: ReactNode;
}) {
  const cls =
    tone === "cancelled"
      ? "bg-ink text-canvas"
      : tone === "attention"
        ? "border-ink text-ink"
        : tone === "live"
          ? "bg-ink text-canvas"
          : "border-line text-muted";
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 text-[10px] font-medium tracking-widest uppercase ${cls}`}
    >
      {children}
    </span>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`border border-line bg-surface ${className ?? ""}`}>{children}</div>;
}

export function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs tracking-widest text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}

export function StepProgress({
  steps,
  current,
}: {
  steps: readonly string[];
  current: string;
}) {
  const index = steps.indexOf(current);
  return (
    <ol className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-medium tracking-widest text-muted uppercase">
      {steps.map((step, i) => (
        <li key={step} className={i === index ? "text-ink" : i < index ? "text-ink/50" : ""}>
          {i + 1} {step}
        </li>
      ))}
    </ol>
  );
}

export function Screen({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`flex min-h-dvh flex-col bg-canvas text-ink ${className ?? ""}`} {...props}>
      {children}
    </div>
  );
}
