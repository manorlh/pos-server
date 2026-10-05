import { SignIn } from '@clerk/nextjs';
import { PoweredBy } from '@/components/powered-by';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-muted/40">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/dashboard"
      />
      <PoweredBy />
    </div>
  );
}
