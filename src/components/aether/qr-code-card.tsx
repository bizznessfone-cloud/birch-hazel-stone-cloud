import { useMemo } from "react";
import { qrMatrix } from "@/lib/aether/qr-code";

export function QrCodeCard({ hotelName, bookingUrl }: { hotelName: string; bookingUrl: string }) {
  const matrix = useMemo(() => qrMatrix(bookingUrl), [bookingUrl]);
  const quiet = 4;
  const size = matrix.length + quiet * 2;

  function download() {
    const parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">',
      '<rect width="100%" height="100%" fill="white"/>',
    ];
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) parts.push('<rect x="' + (x + quiet) + '" y="' + (y + quiet) + '" width="1" height="1"/>');
    }));
    parts.push("</svg>");
    const blob = new Blob([parts.join("")], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = hotelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hotel";
    a.href = url;
    a.download = safeName + "-scan-book-go-qr.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="border border-line bg-surface p-5 print:border-0 print:bg-white print:p-0">
      <div className="flex flex-wrap items-start justify-between gap-4 print:block">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted uppercase print:text-black">Guest QR</p>
          <h2 className="mt-2 text-2xl font-semibold print:text-black">{hotelName}</h2>
          <p className="mt-1 break-all text-xs text-muted print:text-black">{bookingUrl}</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <button type="button" onClick={download} className="min-h-11 border border-line px-4 text-xs font-semibold uppercase">Download SVG</button>
          <button type="button" onClick={() => window.print()} className="min-h-11 bg-ink px-4 text-xs font-semibold text-canvas uppercase">Print</button>
        </div>
      </div>
      <div className="mt-6 flex justify-center bg-white p-6 print:mt-8 print:p-0">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox={"0 0 " + size + " " + size} className="h-72 w-72 max-w-full" shapeRendering="crispEdges" role="img" aria-label={"QR code for " + hotelName}>
          <rect width="100%" height="100%" fill="white" />
          {matrix.map((row, y) => row.map((dark, x) => dark ? (
            <rect key={x + "-" + y} x={x + quiet} y={y + quiet} width="1" height="1" fill="black" />
          ) : null))}
        </svg>
      </div>
      <p className="mt-4 text-center text-sm font-medium print:text-black">Scan to book your hotel transfer</p>
    </section>
  );
}
