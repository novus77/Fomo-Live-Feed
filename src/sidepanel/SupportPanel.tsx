import { useEffect, useRef, useState } from 'react';

import { useLocale } from '../i18n/LocaleProvider';

export const BSC_SUPPORT_ADDRESS =
  '0x373709fdbdcf272cba93164c7d0e3b87b88a1b02';
export const SOLANA_SUPPORT_ADDRESS =
  '4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj';

const TELEGRAM_URL = new URL('https://t.me/XXten177');
const FEEDBACK_DURATION_MS = 2_000;

export interface SupportPanelProps {
  copyText(text: string): Promise<void>;
  openLink(url: URL): void;
}

interface SupportAddressRowProps {
  chain: 'Robinhood & BSC' | 'Solana';
  tone: 'bsc' | 'solana';
  address: string;
  copyText(text: string): Promise<void>;
}

type CopyResult = 'idle' | 'copied' | 'failed';

function SupportAddressRow({
  chain,
  tone,
  address,
  copyText,
}: SupportAddressRowProps) {
  const { translate } = useLocale();
  const [result, setResult] = useState<CopyResult>('idle');
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearTimeout(timerRef.current);
    setResult('idle');

    try {
      await copyText(address);
      if (mountedRef.current && generationRef.current === generation) {
        setResult('copied');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    } catch {
      if (mountedRef.current && generationRef.current === generation) {
        setResult('failed');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    }
  };

  return (
    <div className="support-address-row">
      <div className="support-address-header">
        <strong
          className={`support-chain support-chain-${tone}`}
        >
          {chain}
        </strong>
        <button
          type="button"
          className="support-copy-button"
          aria-label={translate('support.copyAddress', { chain })}
          title={translate('support.copyAddress', { chain })}
          onClick={() => void copy()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M5 2h7a2 2 0 0 1 2 2v7h-2V4H5V2Zm-3 3h7a2 2 0 0 1 2 2v7H4a2 2 0 0 1-2-2V5Zm2 2v5h5V7H4Z"
            />
          </svg>
          <span>{translate('support.copy')}</span>
        </button>
      </div>
      <span className="support-address-value">{address}</span>
      {result === 'copied' && (
        <span role="status" className="support-copy-feedback">
          {translate('support.copied')}
        </span>
      )}
      {result === 'failed' && (
        <span
          role="alert"
          className="support-copy-feedback support-copy-feedback-error"
        >
          {translate('support.copyFailed')}
        </span>
      )}
    </div>
  );
}

export function SupportPanel({ copyText, openLink }: SupportPanelProps) {
  const { translate } = useLocale();
  const benefits = [
    ['support.optimizationTitle', 'support.optimizationBody'],
    ['support.customizationTitle', 'support.customizationBody'],
    ['support.earlyAccessTitle', 'support.earlyAccessBody'],
  ] as const;

  return (
    <section className="support-panel utility-panel" aria-label={translate('support.title')}>
      <h2 className="support-title">{translate('support.title')}</h2>
      <p className="support-thanks">{translate('support.thanks')}</p>

      <div className="support-address-list utility-section">
        <SupportAddressRow
          chain="Robinhood & BSC"
          tone="bsc"
          address={BSC_SUPPORT_ADDRESS}
          copyText={copyText}
        />
        <SupportAddressRow
          chain="Solana"
          tone="solana"
          address={SOLANA_SUPPORT_ADDRESS}
          copyText={copyText}
        />
      </div>

      <section className="support-group-card utility-section">
        <h3 className="support-group-title">
          {translate('support.groupTitle')}
        </h3>
        <p className="support-group-eligibility">
          {translate('support.groupEligibilityBeforeLink')}
          <a
            href={TELEGRAM_URL.href}
            onClick={(event) => {
              event.preventDefault();
              openLink(TELEGRAM_URL);
            }}
          >
            @XXten177
          </a>
          {translate('support.groupEligibilityAfterLink')}
        </p>
        <p className="support-purpose">
          {translate('support.sponsorshipPurpose')}
        </p>
        <p className="support-benefits-intro">
          {translate('support.groupBenefitsIntro')}
        </p>
        <ul className="support-benefits">
          {benefits.map(([title, body]) => (
            <li className="support-benefit" key={title}>
              <strong>{translate(title)}</strong>
              <p>{translate(body)}</p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
