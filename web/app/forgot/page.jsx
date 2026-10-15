"use client";
import { Suspense } from "react";
import { AuthShell, ForgotForm } from "@/components/AuthForms";

export default function Page() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <ForgotForm />
      </Suspense>
    </AuthShell>
  );
}
