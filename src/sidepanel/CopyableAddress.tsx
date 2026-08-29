import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import type { ChainKey } from '../domain/activity';
import { useLocale } from '../i18n/LocaleProvider';
import { validateContractAddress } from '../navigation/contract-address';

export interface CopyableAddressProps {
  chain: ChainKey;
  address: string;
  copyText: (text: string) => Promise<void>;
}

const FEEDBACK_DURATION_MS = 2_000;
const ADDRESS_LABEL_MARKER = '\uE000copyable-address-label\uE001';

function extractAddressLabel(label: string): string {
  return label.split(ADDRESS_LABEL_MARKER).join('');
}

export function CopyableAddress({ chain, address, copyText }: CopyableAddressProps) {
  const { translate } = useLocale();
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  const validation = validateContractAddress(chain, address);
  const displayedAddress = validation.ok ? validation.canonical : address;
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTimeout(resetTimerRef.current);
    };
  }, []);

  // The address itself is untrusted user content; only the "CA:" prefix is an
  // extension-owned label.
  const labelAddress = validation.ok ? displayedAddress : address;
  let localizedLabel = '';
  try {
    localizedLabel = translate('card.caLabel', { address: ADDRESS_LABEL_MARKER });
  } catch {
    // Keep the untrusted address visible even if a malformed catalog throws.
  }
  const addressLabel = extractAddressLabel(localizedLabel);

  if (!validation.ok) {
    return (
      <div
        className="copyable-address copyable-address-untrusted"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="copyable-address-label">{addressLabel}</span>
        <span className="copyable-address-value copyable-address-value-noninteractive">{labelAddress}</span>
      </div>
    );
  }

  const copy = async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearTimeout(resetTimerRef.current);
    setResult('idle');

    try {
      await copyText(displayedAddress);
      if (mountedRef.current && generationRef.current === generation) {
        setResult('copied');
        resetTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    } catch {
      if (mountedRef.current && generationRef.current === generation) {
        setResult('failed');
        resetTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    }
  };

  const handleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    void copy();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      void copy();
    }
  };

  return (
    <div className="copyable-address" onClick={(event) => event.stopPropagation()}>
      <span className="copyable-address-label">{addressLabel}</span>
      <span
        className="copyable-address-value"
        role="button"
        tabIndex={0}
        aria-label={translate('card.copyAddressText')}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {labelAddress}
      </span>
      <button
        type="button"
        className="copyable-address-button"
        aria-label={translate('card.copyAddress')}
        title={translate('card.copyAddress')}
        onClick={handleClick}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" d="M5 2h7a2 2 0 0 1 2 2v7h-2V4H5V2Zm-3 3h7a2 2 0 0 1 2 2v7H4a2 2 0 0 1-2-2V5Zm2 2v5h5V7H4Z" />
        </svg>
      </button>
      {result === 'copied' && <span role="status" className="copyable-address-feedback">{translate('card.addressCopied')}</span>}
      {result === 'failed' && <span role="alert" className="copyable-address-feedback">{translate('card.copyFailed')}</span>}
    </div>
  );
}
