"use client";
import { Suspense } from "react";
import { AuthShell, ResetForm } from "@/components/AuthForms";

export default function Page() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}
