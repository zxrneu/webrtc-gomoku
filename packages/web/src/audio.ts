/**
 * Web Audio API 纯合成音效模块（零外部音频资产依赖）
 *
 * 【为什么用纯代码合成声音？—— 小白科普】：
 * 1. 传统做法：下载 click.mp3、win.wav 等文件，不仅增加网络请求和加载延迟，而且如果要做“单文件独立运行版”，要把音频转成巨大的 base64 字符串塞进 HTML。
 * 2. 现代 Web Audio API：直接用数学公式驱动声卡上的振荡器（Oscillator）振动空气发声！
 *    - 文件体积为 0：全靠十几行代码实时生成声音；
 *    - 响应零延迟：即点即响，无网络缓冲；
 *    - 极佳可控性：可以随意用参数调整音高、音色和衰减曲线。
 */

class SoundEffects {
  /** 浏览器音频上下文对象，相当于一个虚拟的“数字调音台” */
  private ctx: AudioContext | null = null;

  /** 全局音效开关（由顶部导航栏的喇叭按钮控制） */
  public enabled = true;

  /**
   * 获取或初始化 AudioContext（包含浏览器自动播放策略安全唤醒）
   *
   * 【避坑知识点：浏览器的 Autoplay Policy】：
   * 为了防止流氓网站一打开就轰鸣，现代浏览器规定：未经用户手势点击，AudioContext 一律处于 'suspended'（挂起静音）状态。
   * 因此必须在用户点击落子/按钮时，安全调用 ctx.resume() 唤醒声卡。
   */
  private getContext(): AudioContext | null {
    // 若用户禁用了音效，直接返回 null
    if (!this.enabled) return null;

    // 懒加载：只有在第一次需要发声时才初始化 AudioContext
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }

    // 若当前声卡处于挂起静音状态，立即尝试唤醒
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    return this.ctx;
  }

  /**
   * 落子音效：模拟棋子敲击木质棋盘的清脆敲击声
   *
   * 【声学拟真设计秘诀】：
   * 1. 为什么用三角波 (triangle)？
   *    纯正弦波太单薄像电子蜂鸣，方波太刺耳。三角波具有温和的奇次谐波，音色最接近“木头/石块”被敲击的质感。
   * 2. 区分黑白棋音高：
   *    黑棋起始频率 440Hz (A4)，白棋起始频率 520Hz (略高一点)，让双手下棋在听感上有细微层次区别！
   * 3. 频率急速塌陷（Pitch Drop）：
   *    真实落子瞬间，由于棋盘挤压形变，音高会在 80 毫秒内从 440Hz 剧烈俯冲到 110Hz。
   * 4. 音量极速衰减（Volume Decay）：
   *    音量在 80 毫秒内指数衰减到 0.001，创造极具力量感的“啪嗒”短促顿挫！
   *
   * @param isBlack 是否为黑棋落子
   */
  public playStone(isBlack: boolean) {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      // 1. 创建音频核心节点：振荡器（发声源） + 增益器（音量音量控制器）
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      // 2. 配置音色为温润的三角波
      osc.type = 'triangle';
      // 设定起始基频
      osc.frequency.setValueAtTime(isBlack ? 440 : 520, now);
      // 在 80ms 内将频率指数下潜到 110Hz（模拟敲击触底瞬间）
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);

      // 3. 配置音量包络（Envelope）：起始音量 0.5，在 80ms 内指数衰减到近乎无声
      gain.gain.setValueAtTime(0.5, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

      // 4. 音频管道串联：振荡器 -> 音量控制器 -> 最终输出到扬声器 (destination)
      osc.connect(gain);
      gain.connect(ctx.destination);

      // 5. 启动发声并在 90ms 后彻底销毁振荡器释放资源
      osc.start(now);
      osc.stop(now + 0.09);
    } catch {}
  }

  /**
   * 获胜结算音效：大三和弦上行琶音（Arpeggio）
   *
   * 【音乐理论】：
   * 选取明亮欢快的 C 大三和弦：
   * C5 (523.25Hz, Do) -> E5 (659.25Hz, Mi) -> G5 (783.99Hz, Sol) -> C6 (1046.5Hz, 高音 Do)
   * 4 个音符以 90ms 的时间差依次响起，配合纯净正弦波 (sine)，营造充满成就感的胜利庆祝乐！
   */
  public playWin() {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      const now = ctx.currentTime;

      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        // 每个音符依次延后 90ms 响起
        const start = now + idx * 0.09;

        // 使用纯净清脆的正弦波
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);

        // 每个音符持续 400ms 柔和淡出
        gain.gain.setValueAtTime(0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + 0.45);
      });
    } catch {}
  }

  /**
   * 消息提示音效：双音上扬清脆叮咚（Ding-Dong）
   *
   * 用于局内收到对手聊天、悔棋申请或玩家加入时提醒。
   * 由 D5(587.33Hz) 跃升到 A5(880Hz)，上扬音阶自然引起注意。
   */
  public playNotify() {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      osc.type = 'sine';
      // 前 80ms 为较低音 D5
      osc.frequency.setValueAtTime(587.33, now); // D5
      // 80ms 后瞬间跃升到更高音 A5
      osc.frequency.setValueAtTime(880, now + 0.08); // A5

      // 整体在 220ms 内衰减完毕
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.25);
    } catch {}
  }
}

/** 导出全局单例音效对象 */
export const sounds = new SoundEffects();

