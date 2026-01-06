// SPDX-License-Identifier: AGPL-3.0-or-later

import { PushDataV3ApiWrapper } from './mexc-proto/PushDataV3ApiWrapper.ts';

type WsEvent =
  | { type: 'MARKET_DATA'; data: PushDataV3ApiWrapper }
  | { type: 'CONTROL'; data: any };

export class MexcWebsocketClient {
  #ws: WebSocket | null = null;
  readonly #baseUrl = 'wss://wbs-api.mexc.com/ws';
  #pingInterval: ReturnType<typeof setInterval> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #subscriptions: Set<string> = new Set();
  #onMessage: (data: WsEvent) => void;

  constructor(onMessage: (data: WsEvent) => void) {
    this.#onMessage = onMessage;
  }

  connect(): void {
    console.log('Connecting to MEXC WebSocket...');
    this.#ws = new WebSocket(this.#baseUrl);

    // Protobufを扱うために binaryType を設定
    this.#ws.binaryType = 'arraybuffer';

    this.#ws.onopen = () => {
      console.log('✅ WebSocket Connected');
      this.#startHeartbeat();
      this.#resubscribe();
    };

    this.#ws.onmessage = (event: MessageEvent) => {
      this.#handleMessage(event);
    };

    this.#ws.onclose = () => {
      console.warn('⚠️ WebSocket Closed. Reconnecting in 5s...');
      this.#stopHeartbeat();
      this.#reconnect();
    };

    this.#ws.onerror = (err) => {
      console.error('❌ WebSocket Error:', err);
    };
  }

  #send(payload: object): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }

  subscribe(channels: string[]): void {
    channels.forEach(ch => this.#subscriptions.add(ch));
    this.#send({
      method: "SUBSCRIPTION",
      params: channels
    });
  }

  unsubscribe(channels: string[]): void {
    channels.forEach(ch => this.#subscriptions.delete(ch));
    this.#send({
      method: "UNSUBSCRIPTION",
      params: channels
    });
  }

  #handleMessage(event: MessageEvent): void {
    // 1. JSONメッセージの処理
    if (typeof event.data === 'string') {
      try {
        const json = JSON.parse(event.data);
        // メインループをブロックしないよう非同期で通知
        queueMicrotask(() => this.#onMessage({ type: 'CONTROL', data: json }));
      } catch (e) {
        console.error('JSON Parse Error', e);
      }
      return;
    }

    // 2. Protobufメッセージの処理
    if (event.data instanceof ArrayBuffer) {
      try {
        const uint8 = new Uint8Array(event.data);
        const decoded = PushDataV3ApiWrapper.deserializeBinary(uint8);

        // デコード済みデータを非同期で通知
        // これにより、Discord送信処理が重くてもWSの受信（TCPバッファ）を止めない
        queueMicrotask(() => this.#onMessage({ type: 'MARKET_DATA', data: decoded }));
      } catch (e) {
        console.error('Protobuf Deserialization Error', e);
      }
    }
  }

  #startHeartbeat(): void {
    this.#pingInterval = setInterval(() => {
      this.#send({ method: "PING" });
    }, 20000); // 30秒以内に送信する必要があるため20秒間隔
  }

  #stopHeartbeat(): void {
    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
      this.#pingInterval = null;
    }
  }

  #reconnect(): void {
    if (this.#reconnectTimeout) clearTimeout(this.#reconnectTimeout);
    this.#reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  #resubscribe(): void {
    if (this.#subscriptions.size > 0) {
      this.subscribe(Array.from(this.#subscriptions));
    }
  }

  disconnect(): void {
    this.#subscriptions.clear();
    this.#stopHeartbeat();
    if (this.#ws) {
      this.#ws.onclose = null; // 再接続ロジックを回避
      this.#ws.close();
    }
  }
}

// --- 使用例 ---
const client = new MexcWebsocketClient((data) => {
  console.log('Market Data:', data);
});

client.connect();

// BTCUSDTの約定データを購読
setTimeout(() => {
  client.subscribe(['spot@public.aggre.deals.v3.api.pb@100ms@BTCUSDT']);
}, 1000);
