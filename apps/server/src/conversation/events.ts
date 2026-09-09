import type { ServerMessage } from '@llm3d/shared';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ServerEvent = DistributiveOmit<ServerMessage, 'v' | 'id' | 'ts'>;
