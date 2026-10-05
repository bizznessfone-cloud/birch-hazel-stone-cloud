import type { ReactNode } from "react";
import { HotelMark } from "./hotel-mark";

const HOTEL = "The Hotel";

export function PresentationQr({ className }: { className?: string }) {
  const cells = [
    0, 1, 2, 4, 5, 6, 7, 9, 11, 13, 14, 15, 16, 18, 19, 20, 24, 28, 29, 30, 32, 34, 35, 37, 40, 42, 43,
    44, 46, 48,
  ];
  return (
    <svg viewBox="0 0 7 7" className={className} aria-hidden="true">
      {cells.map((cell) => (
        <rect key={cell} x={cell % 7} y={Math.floor(cell / 7)} width="0.86" height="0.86" fill="currentColor" />
      ))}
    </svg>
  );
}

export function DeviceFrame({
  children,
  caption,
  presence = false,
}: {
  children: ReactNode;
  caption: string;
  presence?: boolean;
}) {
  const width = presence ? "w-[min(100%,22rem)]" : "w-[min(100%,17.5rem)]";
  const screen = presence ? "h-[35rem]" : "h-[28rem]";
  return (
    <figure className={width}>
      <div className="border-[12px] border-ink bg-ink">
        <div className="flex h-6 items-center justify-center bg-canvas">
          <span className="h-1 w-10 bg-line" />
        </div>
        <div className={`${screen} overflow-hidden bg-surface text-ink`}>{children}</div>
      </div>
      <figcaption className={`sbg-meta mt-4 ${width}`}>{caption}</figcaption>
    </figure>
  );
}

export function GuestArrivalPlate() {
  return (
    <div aria-hidden="true" className="flex h-full flex-col bg-canvas px-5 py-8 text-center text-ink">
      <div className="flex flex-1 flex-col items-center justify-center">
        <HotelMark name={HOTEL} size="md" />
        <p className="mt-6 text-[10px] font-medium tracking-widest text-muted uppercase">Private hotel transfer</p>
        <p className="mt-3 text-2xl font-semibold tracking-tight">{HOTEL}</p>
        <p className="mt-5 text-[1.65rem] leading-none font-semibold tracking-tight">SCAN. BOOK. GO.</p>
        <p className="mt-4 text-sm leading-relaxed text-muted">Choose a destination. No account needed.</p>
        <div className="mt-8 flex min-h-12 w-full items-center justify-center bg-ink text-sm font-semibold tracking-wide text-canvas uppercase">
          Book transfer
        </div>
      </div>
    </div>
  );
}

export function GuestJourneyPlate() {
  const rows = ["Airport", "Port", "Another hotel"];
  return (
    <div aria-hidden="true" className="flex h-full flex-col bg-canvas px-5 py-6 text-ink">
      <p className="text-[10px] font-medium tracking-widest text-muted uppercase">{HOTEL}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight">Where to?</p>
      <ul className="mt-8">
        {rows.map((row) => (
          <li key={row} className="border-b border-line py-4 text-base">
            {row}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted">The hotel sets the destinations. The guest does not create an account.</p>
      <div className="mt-auto flex min-h-12 items-center justify-center bg-ink text-sm font-semibold tracking-wide text-canvas uppercase">
        Continue
      </div>
    </div>
  );
}
