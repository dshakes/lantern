// Privacy Policy — served at /privacy on the landing origin.
//
// This URL is what you give Google during RCS Business Messaging (RBM) agent
// verification ("Link to brand privacy policy"). It must stay publicly
// reachable. Edit the BRAND block below with your real details, then deploy.
//
// This is a good-faith, plain-language policy for a personal-assistant agent
// that replies to your contacts over RCS/SMS. It is not legal advice; if you
// operate at scale or in a regulated space, have a lawyer review it.

const BRAND = {
  // ── Fill these in ──────────────────────────────────────────────
  name: "Lantern Assistant", // the brand/agent name shown to recipients
  legalEntity: "Lantern Assistant", // your legal business or individual name
  contactEmail: "support@lantern.run", // a monitored inbox
  website: "https://lantern.run",
  effectiveDate: "June 2, 2026",
  // ───────────────────────────────────────────────────────────────
};

export const metadata = {
  title: `Privacy Policy — ${BRAND.name}`,
  description: `How ${BRAND.name} collects, uses, and protects information in its messaging service.`,
};

export default function PrivacyPage() {
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
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-[#9898a8]">
          Effective {BRAND.effectiveDate}
        </p>

        <div className="mt-10 space-y-8 text-[15px] leading-7 text-[#c8c8d4]">
          <section>
            <p>
              This Privacy Policy explains how {BRAND.legalEntity}{" "}
              (&ldquo;we&rdquo;, &ldquo;us&rdquo;) handles information in
              connection with {BRAND.name} (the &ldquo;Service&rdquo;), a
              messaging assistant that sends and receives messages over RCS,
              SMS, and related channels on behalf of its operator. By messaging
              the Service you agree to this Policy.
            </p>
          </section>

          <Section title="Information we collect">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Messages you send.</strong> The content of messages you
                exchange with the Service, so we can understand and respond.
              </li>
              <li>
                <strong>Phone number.</strong> The mobile number you message
                from, used to route replies back to you.
              </li>
              <li>
                <strong>Delivery metadata.</strong> Timestamps and
                carrier/delivery status provided by our messaging provider
                (Twilio) and the carriers, used to deliver messages reliably.
              </li>
            </ul>
            <p className="mt-3">
              We do not knowingly collect special categories of personal data
              and ask that you not send sensitive information (government IDs,
              financial account numbers, health data) over messaging.
            </p>
          </Section>

          <Section title="How we use information">
            <ul className="list-disc space-y-2 pl-5">
              <li>To read your message and generate and deliver a reply.</li>
              <li>To operate, secure, and debug the Service.</li>
              <li>
                To comply with carrier rules and applicable law (for example,
                honoring opt-out requests).
              </li>
            </ul>
            <p className="mt-3">
              Message content may be processed by a third-party large language
              model provider solely to generate a reply. We do not sell your
              personal information, and we do not use your messages for
              third-party advertising.
            </p>
          </Section>

          <Section title="How we share information">
            <p>
              We share information only with service providers that help us run
              the Service, under contractual confidentiality obligations:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>Messaging provider</strong> (Twilio) and mobile
                carriers, to transmit messages.
              </li>
              <li>
                <strong>AI model provider</strong>, to generate replies from
                message content.
              </li>
            </ul>
            <p className="mt-3">
              <strong>
                We do not share mobile information (your mobile phone number or
                SMS opt-in/consent) with any third parties or affiliates for
                marketing or promotional purposes.
              </strong>{" "}
              No mobile information is sold, rented, or shared for marketing. The
              only sharing is with the messaging provider and carriers to deliver
              a message, and the AI provider to generate a reply, as described
              above.
            </p>
            <p className="mt-3">
              We may disclose information if required by law or to protect the
              rights, safety, and security of users and the public.
            </p>
          </Section>

          <Section title="Message frequency, rates, and opt-out">
            <p>
              The Service is conversational: you receive messages in response to
              messages you send. Message and data rates may apply. You can opt
              out at any time by replying <strong>STOP</strong>; you will
              receive one confirmation and no further messages. Reply{" "}
              <strong>HELP</strong> for assistance. Mobile carriers are not
              liable for delayed or undelivered messages.
            </p>
          </Section>

          <Section title="Data retention">
            <p>
              We retain message content and metadata only as long as needed to
              operate the Service and meet legal obligations, then delete or
              de-identify it. You may request deletion of your data by
              contacting us at {BRAND.contactEmail}.
            </p>
          </Section>

          <Section title="Security">
            <p>
              We use reasonable technical and organizational measures to protect
              information, including encryption of credentials at rest and
              access controls. No method of transmission or storage is perfectly
              secure.
            </p>
          </Section>

          <Section title="Your rights">
            <p>
              Depending on where you live, you may have rights to access,
              correct, or delete your personal information, or to object to
              certain processing. To exercise any right, email{" "}
              {BRAND.contactEmail}. We honor opt-out (STOP) requests promptly
              and unconditionally.
            </p>
          </Section>

          <Section title="Children">
            <p>
              The Service is not directed to children under 13 (or the minimum
              age in your jurisdiction), and we do not knowingly collect their
              data.
            </p>
          </Section>

          <Section title="Changes to this Policy">
            <p>
              We may update this Policy from time to time. The
              &ldquo;Effective&rdquo; date above reflects the latest version,
              which will always be posted at this URL.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about this Policy or your data? Email{" "}
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
          <a href="/terms" className="underline underline-offset-4">
            Terms of Service
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
