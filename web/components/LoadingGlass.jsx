"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Mark } from "@/components/Brand";

/**
 * The blurred loading screen. It sits over the current page while a new page loads, shows a short message,
 * then clears to reveal the page. It is kept short on purpose: it clears as soon as the new page has painted.
 */
export default function LoadingGlass() {
  const pathname = usePathname();
  const [on, setOn] = useState(true); // on for the first load too

  useEffect(() => {
    setOn(true);
    const t = setTimeout(() => setOn(false), 420);
    return () => clearTimeout(t);
  }, [pathname]);

  return (
    <div className={`glass-loader ${on ? "on" : ""}`} aria-hidden={!on} role={on ? "status" : undefined}>
      <div className="gl-box">
        <Mark size={54} className="gl-mark" />
        <div className="gl-msg">
          Loading the market
          <span className="gl-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      </div>
    </div>
  );
}
