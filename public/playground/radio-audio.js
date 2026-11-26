// playground/radio-audio.js
// 午夜电台独立音频引擎
// 职责：TTS 语音播放、音乐文件播放、播放/暂停/跳转、进度回调
// 仅服务于 radio.js，不依赖主应用（app.js）的任何全局状态，不修改公共文件

const TTS_URL = 'https://YOUR-TTS-PROXY.workers.dev/api/tts';
const FETCH_TIMEOUT = 90000;
const MAX_TTS_CHARS = 1500;

export const radioAudio = {
  _audio: null,
  _objectUrl: null,
  _controller: null,
  _runId: 0,
  _currentKey: null,
  _playing: false,

  get currentKey() { return this._currentKey; },
  get playing() { return !!(this._playing && this._audio && !this._audio.paused); },
  get currentTime() { return this._audio ? this._audio.currentTime : 0; },
  get duration() {
    return this._audio && isFinite(this._audio.duration) ? this._audio.duration : 0;
  },

  // 停止一切播放并释放资源；每次开始新播放前都会调用
  stop() {
    this._runId += 1;
    if (this._controller) {
      try { this._controller.abort(); } catch (e) { /* ignore */ }
      this._controller = null;
    }
    if (this._audio) {
      const a = this._audio;
      try {
        a.pause();
        a.onloadedmetadata = null;
        a.ontimeupdate = null;
        a.onended = null;
        a.onerror = null;
        a.onplay = null;
        a.onpause = null;
        a.removeAttribute('src');
        a.load();
      } catch (e) { /* ignore */ }
      this._audio = null;
    }
    if (this._objectUrl) {
      try { URL.revokeObjectURL(this._objectUrl); } catch (e) { /* ignore */ }
      this._objectUrl = null;
    }
    this._currentKey = null;
    this._playing = false;
  },

  pause() {
    if (this._audio && !this._audio.paused) this._audio.pause();
  },

  resume() {
    if (this._audio && this._audio.paused) return this._audio.play();
    return Promise.resolve();
  },

  seek(seconds) {
    if (this._audio && isFinite(this._audio.duration)) {
      const target = Math.max(0, Math.min(seconds, Math.max(0, this._audio.duration - 0.3)));
      try { this._audio.currentTime = target; } catch (e) { /* ignore */ }
    }
  },

  // 清洗朗读文本：去掉标签符号、压缩空白、限制长度
  cleanText(text) {
    return String(text == null ? '' : text)
      .replace(/\[[^\]]*\]/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[*_#`>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TTS_CHARS);
  },

  // 内部：把一个音频源挂到 Audio 元素并开始播放
  async _attach({ key, src, isObjectUrl, startAt, onTimeUpdate, onEnded, onError, onStateChange }) {
    const runId = this._runId;
    const audio = new Audio();
    audio.preload = 'auto';
    this._audio = audio;
    if (isObjectUrl) this._objectUrl = src;
    this._currentKey = key;

    audio.onloadedmetadata = () => {
      if (runId !== this._runId) return;
      if (typeof startAt === 'number' && startAt > 0 && isFinite(audio.duration)) {
        try {
          audio.currentTime = Math.min(startAt, Math.max(0, audio.duration - 1));
        } catch (e) { /* ignore */ }
      }
    };

    audio.ontimeupdate = () => {
      if (runId !== this._runId) return;
      if (typeof onTimeUpdate === 'function') {
        onTimeUpdate(audio.currentTime, isFinite(audio.duration) ? audio.duration : 0);
      }
    };

    audio.onplay = () => {
      if (runId !== this._runId) return;
      this._playing = true;
      if (typeof onStateChange === 'function') onStateChange('playing');
    };

    audio.onpause = () => {
      if (runId !== this._runId) return;
      this._playing = false;
      if (typeof onStateChange === 'function') onStateChange('paused');
    };

    audio.onended = () => {
      if (runId !== this._runId) return;
      this._playing = false;
      if (typeof onEnded === 'function') onEnded(isFinite(audio.duration) ? audio.duration : 0);
    };

    audio.onerror = (e) => {
      if (runId !== this._runId) return;
      this._playing = false;
      if (typeof onError === 'function') onError(e);
    };

    audio.src = src;
    try {
      await audio.play();
    } catch (err) {
      if (runId === this._runId && typeof onError === 'function') onError(err);
      throw err;
    }
  },

  // 播放一期节目的朗读语音
  async playSpeech({ key, text, startAt = 0, onTimeUpdate, onEnded, onError, onStateChange }) {
    this.stop();
    const runId = this._runId;
    const controller = new AbortController();
    this._controller = controller;
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: this.cleanText(text) }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('语音服务返回 ' + res.status);
      const blob = await res.blob();
      if (!blob || !blob.size) throw new Error('语音服务返回了空内容');
      if (runId !== this._runId) return;
      const url = URL.createObjectURL(blob);
      await this._attach({
        key, src: url, isObjectUrl: true, startAt,
        onTimeUpdate, onEnded, onError, onStateChange,
      });
    } catch (err) {
      clearTimeout(timer);
      if (runId !== this._runId) return;
      if (err && err.name === 'AbortError') throw new Error('语音准备超时了，请稍后再试');
      throw err;
    } finally {
      if (this._controller === controller) this._controller = null;
    }
  },

  // 播放一首曲目（本地音频文件）
  async playMusic({ key, src, startAt = 0, onTimeUpdate, onEnded, onError, onStateChange }) {
    this.stop();
    await this._attach({
      key, src, isObjectUrl: false, startAt,
      onTimeUpdate, onEnded, onError, onStateChange,
    });
  },
};
