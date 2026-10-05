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
  actions,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  const heading = (
    <div>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1 className={`${eyebrow ? "mt-1" : ""} text-3xl font-semibold tracking-tight`}>{title}</h1>
      {lead ? <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{lead}</p> : null}
    </div>
  );
  if (!actions) return heading;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      {heading}
      <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
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

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs tracking-widest text-muted uppercase">{label}</span>
      {children}
      {error ? (
        <span className="mt-2 block text-sm text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-2 block text-sm leading-relaxed text-muted">{hint}</span>
      ) : null}
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

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const buttonVariantClass: Record<ButtonVariant, string> = {
  primary: "border border-ink bg-ink text-canvas hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:border-ink",
  quiet: "border border-transparent bg-transparent text-ink hover:border-line",
  danger: "border border-danger bg-transparent text-danger hover:bg-surface",
};

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      {...props}
      className={`inline-flex min-h-11 items-center justify-center px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${buttonVariantClass[variant]} ${className ?? ""}`}
    />
  );
}

export function Container({
  wide = false,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { wide?: boolean }) {
  return (
    <div className={`sbg-container ${wide ? "sbg-container-wide" : ""} ${className ?? ""}`} {...props}>
      {children}
    </div>
  );
}

export function Section({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`py-10 md:py-14 ${className ?? ""}`} {...props}>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="border border-line bg-surface px-4 py-4">
      <p className="sbg-label">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {note ? <p className="sbg-meta mt-1">{note}</p> : null}
    </div>
  );
}

export function Status({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "attention" | "danger";
  children: ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "border-danger text-danger"
      : tone === "neutral"
        ? "border-line text-muted"
        : "border-ink text-ink";
  return (
    <span className={`inline-flex min-h-6 items-center border px-2 text-[10px] font-medium tracking-widest uppercase ${cls}`}>
      {children}
    </span>
  );
}

export function PublicHeader({
  brand = "SCAN. BOOK. GO.",
  wide = false,
  children,
}: {
  brand?: string;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="bg-canvas text-ink">
      <Container wide={wide} className="flex min-h-[4.5rem] items-center justify-between gap-6 py-4">
        <a href="#product" className="text-sm font-semibold tracking-[0.2em] uppercase md:text-base">
          {brand}
        </a>
        {children ? <div className="flex items-center gap-2">{children}</div> : null}
      </Container>
    </header>
  );
}

export function PublicFooter({ wide = false, children }: { wide?: boolean; children?: ReactNode }) {
  return (
    <footer className="bg-canvas text-ink">
      <Container wide={wide} className="flex flex-col gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs tracking-[0.2em] text-muted uppercase">SCAN. BOOK. GO.</p>
        {children ? <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted">{children}</div> : null}
      </Container>
    </footer>
  );
}
