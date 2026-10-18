"use client";
import SubNav from "@/components/SubNav";
import AIChat from "@/components/terminal/AIChat";
import { RequireAuth } from "@/components/ui";

export default function AIPage() {
  return (
    <RequireAuth>
      <div className="page lab-page ai-page">
        <SubNav />
        <div className="ai-shell">
          <AIChat page />
        </div>
      </div>
    </RequireAuth>
  );
}
