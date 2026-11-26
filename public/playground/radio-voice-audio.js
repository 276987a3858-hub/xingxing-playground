// playground/radio-voice-audio.js
// 午夜电台 · 中文本地录音播放器（独立实例）
// 职责：用自己独立的 Audio 元素播放 radio-voice.js 里的本地 Blob。
// 隔离：不引用 radioAudio（英文 TTS）、不引用 radioMusic（音乐），三者各自持有 Audio 实例，互不干扰。
// 边界：不发起任何网络请求、不调用 TTS、不做声音克隆。

export const radioVoiceAudio = {
  _audio: null,
  _objectUrl: null,
  _runId: 0,
  _currentId: null,
  _playing: false,

  get currentId() { return this._currentId; },
  get playing() { return !!(this._playing && this._audio && !this._audio.paused); },
  get currentTime() { return this._audio ? this._audio.currentTime : 0; },
  get duration() {
    return this._audio && isFinite(this._audio.duration) ? this._audio.duration : 0;
  },

  // 停止播放并释放当前 objectURL 与回调；每次新播放前都会调用
  stop() {
    this._runId += 1;
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
    this._currentId = null;
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

  // 播放一段本地 Blob 录音
  // { id, blob, startAt, onTimeUpdate, onEnded, onError, onStateChange }
  async play({ id, blob, startAt = 0, onTimeUpdate, onEnded, onError, onStateChange } = {}) {
    this.stop();
    if (!(blob instanceof Blob) || blob.size <= 0) {
      const err = new Error('录音素材为空，无法播放');
      if (typeof onError === 'function') onError(err);
      throw err;
    }
    const runId = this._runId;
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = 'auto';
    this._audio = audio;
    this._objectUrl = url;
    this._currentId = typeof id === 'string' ? id : null;

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
    audio.onerror = e => {
      if (runId !== this._runId) return;
      this._playing = false;
      if (typeof onError === 'function') onError(e);
    };

    audio.src = url;
    try {
      await audio.play();
    } catch (err) {
      if (runId === this._runId && typeof onError === 'function') onError(err);
      throw err;
    }
  },
};
