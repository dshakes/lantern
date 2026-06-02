// Terms of Service — served at /terms on the landing origin.
//
// This URL is what you give Google during RCS Business Messaging (RBM) agent
// verification ("Link to brand terms of service"). It must stay publicly
// reachable. Edit the BRAND block below with your real details, then deploy.
//
// Plain-language terms for a personal-assistant agent that messages contacts
// over RCS/SMS. Not legal advice.

const BRAND = {
  // ── Fill these in ──────────────────────────────────────────────
  name: "Lantern Assistant",
  legalEntity: "Lantern Assistant",
  contactEmail: "support@lantern.run",
  website: "https://lantern.run",
  governingLaw: "the State of Delaware, USA", // your jurisdiction
  effectiveDate: "June 2, 2026",
  // ───────────────────────────────────────────────────────────────
};

export const metadata = {
  title: `Terms of Service — ${BRAND.name}`,
  description: `The terms governing use of the ${BRAND.name} messaging service.`,
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#060609] text-[#f0f0f5]">
      <article className="mx-auto max-w-3xl px-6 py-20">
        <a
          href="/"
          className="text-sm text-[#9898a8] hover:text-[#f0f0f5] transition-colors"
        >
          ← {BRAND.name}
        </a>

        <h1 className="mt-8 text-3xl font-bold tracking-tight">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-[#9898a8]">
          Effective {BRAND.effectiveDate}
        </p>

        <div className="mt-10 space-y-8 text-[15px] leading-7 text-[#c8c8d4]">
          <section>
            <p>
              These Terms of Service (&ldquo;Terms&rdquo;) govern your use of{" "}
              {BRAND.name} (the &ldquo;Service&rdquo;), a messaging assistant
              operated by {BRAND.legalEntity} that sends and receives messages
              over RCS, SMS, and related channels. By messaging the Service, you
              agree to these Terms. If you do not agree, do not use the Service.
            </p>
          </section>

          <Section title="The Service">
            <p>
              The Service is a conversational assistant that responds to
              messages you send. Replies may be generated with the help of
              automated systems, including AI models. The Service is provided
              for personal, lawful communication.
            </p>
          </Section>

          <Section title="Consent to receive messages">
            <p>
              By messaging the Service, you consent to receive reply messages at
              the number you used. The Service only messages you in response to
              your messages or with your prior consent. Message and data rates
              may apply depending on your mobile plan.
            </p>
          </Section>

          <Section title="Opting out and help">
            <p>
              You may opt out at any time by replying <strong>STOP</strong>.
              After you opt out, you will receive a single confirmation and no
              further messages unless you opt back in. Reply{" "}
              <strong>HELP</strong> for help, or contact us at{" "}
              {BRAND.contactEmail}.
            </p>
          </Section>

          <Section title="Acceptable use">
            <p>You agree not to use the Service to:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>break any law or regulation;</li>
              <li>
                send unlawful, harassing, hateful, fraudulent, or abusive
                content;
              </li>
              <li>
                attempt to disrupt, reverse engineer, or gain unauthorized
                access to the Service;
              </li>
              <li>
                impersonate others or send unsolicited bulk messages (spam)
                through the Service.
              </li>
            </ul>
          </Section>

          <Section title="No professional advice">
            <p>
              Responses are provided for general informational and convenience
              purposes only and may be inaccurate or incomplete. They are not
              professional advice (legal, medical, financial, or otherwise). Use
              your own judgment and verify anything important.
            </p>
          </Section>

          <Section title="Availability">
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as
              available.&rdquo; We do not guarantee that it will be
              uninterrupted, timely, secure, or error-free, and message delivery
              depends on mobile carriers and third-party providers we do not
              control.
            </p>
          </Section>

          <Section title="Disclaimers and limitation of liability">
            <p>
              To the fullest extent permitted by law, we disclaim all
              warranties, express or implied, including merchantability, fitness
              for a particular purpose, and non-infringement. To the fullest
              extent permitted by law, {BRAND.legalEntity} will not be liable
              for any indirect, incidental, special, consequential, or punitive
              damages, or any loss arising from your use of or inability to use
              the Service. Mobile carriers are not liable for delayed or
              undelivered messages.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              We may modify these Terms or the Service at any time. The
              &ldquo;Effective&rdquo; date above reflects the latest version,
              which will always be posted at this URL. Continued use after a
              change means you accept the updated Terms.
            </p>
          </Section>

          <Section title="Governing law">
            <p>
              These Terms are governed by the laws of {BRAND.governingLaw},
              without regard to its conflict-of-laws rules.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about these Terms? Email{" "}
              <a
                href={`mailto:${BRAND.contactEmail}`}
                className="text-[#f0f0f5] underline underline-offset-4"
              >
                {BRAND.contactEmail}
              </a>
              .
            </p>
          </Section>
        </div>

        <p className="mt-16 text-sm text-[#9898a8]">
          <a href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </a>
        </p>
      </article>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-[#f0f0f5]">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
