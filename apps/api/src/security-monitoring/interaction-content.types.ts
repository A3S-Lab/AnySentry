export type InteractionContentState = 'pending' | 'accepted' | 'deleted';

export interface EncryptedInteractionContent {
  contentRef: string;
  interactionId: string;
  conversationId: string;
  sourceId: string;
  sourceEventId: string;
  tenantId: string;
  contentRole: 'user_instruction' | 'assistant_response';
  contentSha256: string;
  contentBytes: number;
  keyVersion: string;
  algorithm: 'aes-256-gcm';
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  finalizedAt: number;
}

export interface StoredInteractionContent extends EncryptedInteractionContent {
  state: InteractionContentState;
  acceptedAt?: number;
  deletedAt?: number;
}

export type InteractionContentFinalizeResult =
  | { state: 'stored' | 'duplicate'; record: StoredInteractionContent }
  | { state: 'conflict' | 'unavailable' };

export interface InteractionContentView {
  schemaVersion: 'anysentry.interaction-content.v1';
  interactionId: string;
  conversationId: string;
  contentRef: string;
  messageRole: 'user' | 'assistant';
  contentRole: 'user_instruction' | 'assistant_response';
  content: string;
  contentBytes: number;
  contentSha256: string;
  keyVersion: string;
  rawRetentionState: 'encrypted';
  presentationState: 'raw_authorized';
}
