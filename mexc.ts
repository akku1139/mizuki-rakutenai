// SPDX-License-Identifier: AGPL-3.0-or-later

import { PushDataV3ApiWrapper } from './mexc-proto/PushDataV3ApiWrapper.ts';

export class MexcWebsocketClient {
  #ws: WebSocket | null = null;
  readonly #baseUrl = 'wss://wbs-api.mexc.com/ws';
  #pingInterval: ReturnType<typeof setInterval> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #subscriptions: Set<string> = new Set();
  #onMessage: (data: any) => void;

  constructor(onMessage: (data: any) => void) {
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
    try {
      // PING/PONGや購読確認などはJSONで届く
      if (typeof event.data === 'string') {
        const data = JSON.parse(event.data);
        if (data.msg === 'PONG') return;
        this.#onMessage(data);
      }
      // マーケットデータ（Protobuf）は ArrayBuffer で届く
      else if (event.data instanceof ArrayBuffer) {
        const decoded = PushDataV3ApiWrapper.deserializeBinary(new Uint8Array(event.data));
        this.#onMessage(decoded);
        console.log('Binary data received (Protobuf)');
      }
    } catch (e) {
      console.error('Data parsing error:', e);
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
