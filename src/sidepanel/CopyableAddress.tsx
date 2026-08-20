import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import type { ChainKey } from '../domain/activity';
import { validateContractAddress } from '../navigation/contract-address';

export interface CopyableAddressProps {
  chain: ChainKey;
  address: string;
  copyText: (text: string) => Promise<void>;
}

export function CopyableAddress({ chain, address, copyText }: CopyableAddressProps) {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  const validation = validateContractAddress(chain, address);
  const displayedAddress = validation.ok ? validation.canonical : address;

  const copy = async (): Promise<void> => {
    try {
      await copyText(displayedAddress);
      setResult('copied');
    } catch {
      setResult('failed');
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
      <span
        className="copyable-address-value"
        role="button"
        tabIndex={0}
        aria-label="Copy address text"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        CA: {displayedAddress}
      </span>
      <button
        type="button"
        className="copyable-address-button"
        aria-label="Copy full address"
        title="Copy full address"
        onClick={handleClick}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" d="M5 2h7a2 2 0 0 1 2 2v7h-2V4H5V2Zm-3 3h7a2 2 0 0 1 2 2v7H4a2 2 0 0 1-2-2V5Zm2 2v5h5V7H4Z" />
        </svg>
      </button>
      {result === 'copied' && <span role="status" className="copyable-address-feedback">Copied</span>}
      {result === 'failed' && <span role="alert" className="copyable-address-feedback">Copy failed</span>}
    </div>
  );
}
