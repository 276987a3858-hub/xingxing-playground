/* =====================================================
   和小星一起背单词 · 词库与题型数据
   负责：词条数据、难度分档、干扰项与题目生成
   纯数据模块：不碰 DOM，不碰网络，不碰其他游戏
   ===================================================== */

// 词条字段：w 单词 / ph 音标 / pos 词性 / cn 释义 / ex 例句 / exCn 例句译文 / lv 难度 / tip 记忆提示
export const WORDS = [
  // ===== 四级 CET-4 =====
  { w: 'abandon', ph: '/əˈbændən/', pos: 'v.', cn: '放弃；抛弃', ex: 'They had to abandon the plan due to lack of funds.', exCn: '由于资金不足，他们不得不放弃这个计划。', lv: 'cet4', tip: 'a-band-on，想象" band（乐队）"被丢下' },
  { w: 'benefit', ph: '/ˈbenɪfɪt/', pos: 'n./v.', cn: '益处；受益', ex: 'Regular exercise benefits your health.', exCn: '规律运动对健康有益。', lv: 'cet4', tip: 'bene（好）+ fit，合适的就是有益的' },
  { w: 'campaign', ph: '/kæmˈpeɪn/', pos: 'n.', cn: '运动；战役', ex: 'They launched a campaign against smoking.', exCn: '他们发起了一场禁烟运动。', lv: 'cet4', tip: 'cam-paign，和"camp 营地"同源' },
  { w: 'decline', ph: '/dɪˈklaɪn/', pos: 'v./n.', cn: '下降；婉拒', ex: 'Sales declined sharply last month.', exCn: '上月销量急剧下降。', lv: 'cet4', tip: 'de（向下）+ cline（倾斜）' },
  { w: 'efficient', ph: '/ɪˈfɪʃnt/', pos: 'adj.', cn: '高效的', ex: 'She is an efficient worker.', exCn: '她是个高效的工作者。', lv: 'cet4', tip: 'effort（努力）做得好就是 efficient' },
  { w: 'genuine', ph: '/ˈdʒenjuɪn/', pos: 'adj.', cn: '真正的；真诚的', ex: 'He showed genuine concern for her.', exCn: '他对她表现出真诚的关心。', lv: 'cet4', tip: 'gen（出生）天生的，不是假的' },
  { w: 'hesitate', ph: '/ˈhezɪteɪt/', pos: 'v.', cn: '犹豫', ex: 'Don’t hesitate to ask for help.', exCn: '别犹豫，尽管求助。', lv: 'cet4', tip: 'hesi-tate，卡住不动就是犹豫' },
  { w: 'identify', ph: '/aɪˈdentɪfaɪ/', pos: 'v.', cn: '识别；确认', ex: 'Can you identify the man in the photo?', exCn: '你能认出照片里的男人吗？', lv: 'cet4', tip: 'ident（身份）+ ify，确认身份' },
  { w: 'maintain', ph: '/meɪnˈteɪn/', pos: 'v.', cn: '维持；保养', ex: 'It is important to maintain a healthy diet.', exCn: '保持健康饮食很重要。', lv: 'cet4', tip: 'main（主要）+ tain（持有）' },
  { w: 'obvious', ph: '/ˈɒbviəs/', pos: 'adj.', cn: '明显的', ex: 'The answer is quite obvious.', exCn: '答案相当明显。', lv: 'cet4', tip: 'ob（朝）+ vi（看），一眼就看到' },
  { w: 'previous', ph: '/ˈpriːviəs/', pos: 'adj.', cn: '先前的', ex: 'This is better than the previous version.', exCn: '这比先前的版本更好。', lv: 'cet4', tip: 'pre（前）+ vi（看）' },
  { w: 'reduce', ph: '/rɪˈdjuːs/', pos: 'v.', cn: '减少', ex: 'We need to reduce costs.', exCn: '我们需要降低成本。', lv: 'cet4', tip: 're（回）+ duce（引导），往回带' },
  { w: 'sufficient', ph: '/səˈfɪʃnt/', pos: 'adj.', cn: '充足的', ex: 'We have sufficient time to finish.', exCn: '我们有充足的时间完成。', lv: 'cet4', tip: 'suf（下）+ fice（做），做够了' },
  { w: 'temporary', ph: '/ˈtemprəri/', pos: 'adj.', cn: '暂时的', ex: 'This is a temporary solution.', exCn: '这是个临时的解决办法。', lv: 'cet4', tip: 'tempor（时间），只在一时' },
  { w: 'various', ph: '/ˈveəriəs/', pos: 'adj.', cn: '各种各样的', ex: 'The shop sells various goods.', exCn: '这家店售卖各种商品。', lv: 'cet4', tip: 'vary（变化）的形容词' },
  { w: 'witness', ph: '/ˈwɪtnəs/', pos: 'n./v.', cn: '目击者；目击', ex: 'She witnessed the accident.', exCn: '她目击了那起事故。', lv: 'cet4', tip: 'wit（知道）+ ness，亲耳所见' },
  { w: 'curious', ph: '/ˈkjʊəriəs/', pos: 'adj.', cn: '好奇的', ex: 'The child is curious about everything.', exCn: '这孩子对一切都好奇。', lv: 'cet4', tip: 'curi（关心）+ ous' },
  { w: 'decorate', ph: '/ˈdekəreɪt/', pos: 'v.', cn: '装饰', ex: 'They decorated the room with flowers.', exCn: '他们用花装饰了房间。', lv: 'cet4', tip: 'decor（装饰）+ ate' },
  { w: 'familiar', ph: '/fəˈmɪliə/', pos: 'adj.', cn: '熟悉的', ex: 'This song sounds familiar.', exCn: '这首歌听起来很熟悉。', lv: 'cet4', tip: 'family（家庭）般熟悉' },
  { w: 'occur', ph: '/əˈkɜː/', pos: 'v.', cn: '发生；出现', ex: 'The accident occurred at midnight.', exCn: '事故发生在午夜。', lv: 'cet4', tip: 'oc + cur（跑），事情跑来了' },

  // ===== 六级 CET-6 =====
  { w: 'acknowledge', ph: '/əkˈnɒlɪdʒ/', pos: 'v.', cn: '承认；致谢', ex: 'He acknowledged his mistake.', exCn: '他承认了自己的错误。', lv: 'cet6', tip: 'ac + knowledge（知道），表示知道并承认' },
  { w: 'brilliant', ph: '/ˈbrɪliənt/', pos: 'adj.', cn: '杰出的；明亮的', ex: 'She had a brilliant idea.', exCn: '她有个绝妙的主意。', lv: 'cet6', tip: 'brill（发光）+ iant' },
  { w: 'compromise', ph: '/ˈkɒmprəmaɪz/', pos: 'n./v.', cn: '妥协；折中', ex: 'Both sides reached a compromise.', exCn: '双方达成了妥协。', lv: 'cet6', tip: 'com（共同）+ promise（承诺）' },
  { w: 'deliberate', ph: '/dɪˈlɪbərət/', pos: 'adj.', cn: '深思熟虑的；故意的', ex: 'It was a deliberate decision.', exCn: '那是个深思熟虑的决定。', lv: 'cet6', tip: 'de + liber（自由衡量）' },
  { w: 'elaborate', ph: '/ɪˈlæbərət/', pos: 'adj./v.', cn: '详尽的；详述', ex: 'Could you elaborate on that point?', exCn: '你能详细说明那一点吗？', lv: 'cet6', tip: 'e + labor（ labor 劳动），花功夫做详细' },
  { w: 'fundamental', ph: '/ˌfʌndəˈmentl/', pos: 'adj.', cn: '基本的；根本的', ex: 'This is a fundamental problem.', exCn: '这是个根本问题。', lv: 'cet6', tip: 'fund（基础）+ mental' },
  { w: 'guarantee', ph: '/ˌɡærənˈtiː/', pos: 'v./n.', cn: '保证；担保', ex: 'We guarantee the quality.', exCn: '我们保证质量。', lv: 'cet6', tip: 'guar（守卫）+ antee' },
  { w: 'hierarchy', ph: '/ˈhaɪərɑːki/', pos: 'n.', cn: '等级制度；层级', ex: 'The company has a flat hierarchy.', exCn: '这家公司层级扁平。', lv: 'cet6', tip: 'hier（神圣）+ archy（统治）' },
  { w: 'inevitable', ph: '/ɪnˈevɪtəbl/', pos: 'adj.', cn: '不可避免的', ex: 'Change is inevitable.', exCn: '变化不可避免。', lv: 'cet6', tip: 'in（不）+ evit（避免）+ able' },
  { w: 'justify', ph: '/ˈdʒʌstɪfaɪ/', pos: 'v.', cn: '证明…正当', ex: 'How can you justify this decision?', exCn: '你如何证明这个决定是正当的？', lv: 'cet6', tip: 'just（公正）+ ify' },
  { w: 'reluctant', ph: '/rɪˈlʌktənt/', pos: 'adj.', cn: '不情愿的', ex: 'He was reluctant to leave.', exCn: '他不愿离开。', lv: 'cet6', tip: 're（反）+ luct（挣扎）' },
  { w: 'sophisticated', ph: '/səˈfɪstɪkeɪtɪd/', pos: 'adj.', cn: '复杂的；老练的', ex: 'This is sophisticated equipment.', exCn: '这是精密的设备。', lv: 'cet6', tip: 'sophist（诡辩家），非常讲究' },
  { w: 'tremendous', ph: '/trəˈmendəs/', pos: 'adj.', cn: '巨大的；极好的', ex: 'She made tremendous progress.', exCn: '她取得了巨大进步。', lv: 'cet6', tip: 'trem（颤抖）+ endous，大到发抖' },
  { w: 'underestimate', ph: '/ˌʌndərˈestɪmeɪt/', pos: 'v.', cn: '低估', ex: 'Never underestimate your opponent.', exCn: '永远不要低估对手。', lv: 'cet6', tip: 'under（下）+ estimate（估计）' },
  { w: 'versatile', ph: '/ˈvɜːsətaɪl/', pos: 'adj.', cn: '多才多艺的；多功能的', ex: 'She is a versatile actress.', exCn: '她是位多才多艺的演员。', lv: 'cet6', tip: 'vers（转）+ atile，能转向各方' },
  { w: 'withstand', ph: '/wɪðˈstænd/', pos: 'v.', cn: '承受；抵挡', ex: 'The wall can withstand strong wind.', exCn: '这堵墙能抵御强风。', lv: 'cet6', tip: 'with（against）+ stand（站）' },
  { w: 'consequence', ph: '/ˈkɒnsɪkwəns/', pos: 'n.', cn: '后果；结果', ex: 'You must accept the consequences.', exCn: '你必须承担后果。', lv: 'cet6', tip: 'con + sequ（跟随）+ ence' },
  { w: 'diminish', ph: '/dɪˈmɪnɪʃ/', pos: 'v.', cn: '减少；削弱', ex: 'The pain gradually diminished.', exCn: '疼痛逐渐减轻。', lv: 'cet6', tip: 'di + mini（小）+ sh' },
  { w: 'perspective', ph: '/pəˈspektɪv/', pos: 'n.', cn: '视角；观点', ex: 'View it from a different perspective.', exCn: '从不同的角度看它。', lv: 'cet6', tip: 'per（贯穿）+ spect（看）' },
  { w: 'substantial', ph: '/səbˈstænʃl/', pos: 'adj.', cn: '大量的；实质的', ex: 'There was a substantial increase.', exCn: '有大幅增长。', lv: 'cet6', tip: 'sub + stance（站立）+ ial' },

  // ===== 考研 KAOYAN =====
  { w: 'abnormal', ph: '/æbˈnɔːml/', pos: 'adj.', cn: '异常的', ex: 'The results were abnormal.', exCn: '结果异常。', lv: 'kaoyan', tip: 'ab（离开）+ normal（正常）' },
  { w: 'coherent', ph: '/kəʊˈhɪərənt/', pos: 'adj.', cn: '连贯的；一致的', ex: 'He gave a coherent explanation.', exCn: '他给出了连贯的解释。', lv: 'kaoyan', tip: 'co（共同）+ here（黏着）' },
  { w: 'deteriorate', ph: '/dɪˈtɪəriəreɪt/', pos: 'v.', cn: '恶化；退化', ex: 'His health deteriorated rapidly.', exCn: '他的健康迅速恶化。', lv: 'kaoyan', tip: 'deterior（更坏）+ ate' },
  { w: 'explicit', ph: '/ɪkˈsplɪsɪt/', pos: 'adj.', cn: '明确的；清楚的', ex: 'She gave explicit instructions.', exCn: '她给了明确的指示。', lv: 'kaoyan', tip: 'ex（出）+ plic（折叠）摊开说' },
  { w: 'fluctuate', ph: '/ˈflʌktʃueɪt/', pos: 'v.', cn: '波动；起伏', ex: 'Prices fluctuated wildly.', exCn: '价格剧烈波动。', lv: 'kaoyan', tip: 'fluct（流动）+ uate' },
  { w: 'hypothesis', ph: '/haɪˈpɒθəsɪs/', pos: 'n.', cn: '假设；假说', ex: 'The hypothesis was proved wrong.', exCn: '这个假说被证明是错的。', lv: 'kaoyan', tip: 'hypo（下）+ thesis（论点）' },
  { w: 'inevitably', ph: '/ɪnˈevɪtəbli/', pos: 'adv.', cn: '不可避免地', ex: 'Mistakes inevitably happen.', exCn: '错误不可避免地会发生。', lv: 'kaoyan', tip: 'inevitable 的副词形式' },
  { w: 'legitimate', ph: '/lɪˈdʒɪtɪmət/', pos: 'adj.', cn: '合法的；合理的', ex: 'That is a legitimate concern.', exCn: '那是合理的担忧。', lv: 'kaoyan', tip: 'leg（法律）+ itimate' },
  { w: 'manipulate', ph: '/məˈnɪpjuleɪt/', pos: 'v.', cn: '操纵；控制', ex: 'He manipulated the data.', exCn: '他操纵了数据。', lv: 'kaoyan', tip: 'mani（手）+ pul（拉）用手操作' },
  { w: 'notion', ph: '/ˈnəʊʃn/', pos: 'n.', cn: '概念；观念', ex: 'I have no notion of what he means.', exCn: '我完全不明白他的意思。', lv: 'kaoyan', tip: 'not（知道）+ ion' },
  { w: 'optimistic', ph: '/ˌɒptɪˈmɪstɪk/', pos: 'adj.', cn: '乐观的', ex: 'She remains optimistic.', exCn: '她依然乐观。', lv: 'kaoyan', tip: 'optim（最好）+ istic' },
  { w: 'precise', ph: '/prɪˈsaɪs/', pos: 'adj.', cn: '精确的', ex: 'Give me the precise figure.', exCn: '给我精确的数字。', lv: 'kaoyan', tip: 'pre + cis（切）切得刚好' },
  { w: 'reluctance', ph: '/rɪˈlʌktəns/', pos: 'n.', cn: '不情愿', ex: 'He agreed with reluctance.', exCn: '他勉强同意了。', lv: 'kaoyan', tip: 'reluctant 的名词形式' },
  { w: 'simultaneous', ph: '/ˌsɪmlˈteɪniəs/', pos: 'adj.', cn: '同时发生的', ex: 'There were simultaneous events.', exCn: '有几件事同时发生。', lv: 'kaoyan', tip: 'simul（同时）+ taneous' },
  { w: 'trigger', ph: '/ˈtrɪɡə/', pos: 'v./n.', cn: '引发；扳机', ex: 'The incident triggered a debate.', exCn: '该事件引发了一场辩论。', lv: 'kaoyan', tip: 'trigger 本意是枪的扳机' },
  { w: 'vulnerable', ph: '/ˈvʌlnərəbl/', pos: 'adj.', cn: '脆弱的；易受伤的', ex: 'The system is vulnerable to attack.', exCn: '这个系统易受攻击。', lv: 'kaoyan', tip: 'vulner（伤口）+ able' },
  { w: 'ambiguous', ph: '/æmˈbɪɡjuəs/', pos: 'adj.', cn: '模棱两可的', ex: 'His answer was ambiguous.', exCn: '他的回答模棱两可。', lv: 'kaoyan', tip: 'ambi（两边）+ ag（走）' },
  { w: 'conventional', ph: '/kənˈvenʃənl/', pos: 'adj.', cn: '传统的；常规的', ex: 'This is a conventional method.', exCn: '这是传统方法。', lv: 'kaoyan', tip: 'con + vent（来）+ ional' },
  { w: 'empirical', ph: '/ɪmˈpɪrɪkl/', pos: 'adj.', cn: '经验主义的；实证的', ex: 'There is empirical evidence.', exCn: '有实证证据。', lv: 'kaoyan', tip: 'em + pir（尝试）+ ical' },
  { w: 'rational', ph: '/ˈræʃənl/', pos: 'adj.', cn: '理性的；合理的', ex: 'Make a rational decision.', exCn: '做一个理性的决定。', lv: 'kaoyan', tip: 'ratio（推理）+ nal' }
];

// 可选难度：四级已移除（不再作为新学习内容来源）
// 注意：WORDS 中的 cet4 词条仍保留，仅供历史记录里已学过的四级词显示中文，不参与出题
export const LEVELS = [
  { id: 'cet6', name: '六级', desc: '进阶核心词' },
  { id: 'kaoyan', name: '考研', desc: '辨析与熟词僻义' }
];

// 作为新学习内容来源的难度（与 LEVELS 一致，用于干扰项补齐等内部过滤）
export const ACTIVE_LEVELS = LEVELS.map(l => l.id);

export const QUESTION_TYPES = [
  { id: 'word2cn', name: '看词选义', desc: '看英文，选中文释义' },
  { id: 'cn2word', name: '看义选词', desc: '看中文，选英文单词' },
  { id: 'spell', name: '拼写填空', desc: '看提示，补全单词' },
  { id: 'listen', name: '听音选词', desc: '听发音，选出单词' }
];

export function getWordsByLevel(level) {
  return WORDS.filter(item => item.lv === level);
}

// 仅返回可作为新学习内容的词条（排除已下线的四级）
export function getActiveWords() {
  return WORDS.filter(item => ACTIVE_LEVELS.includes(item.lv));
}

/**
 * 抽取"全新词"：从未学过、且未掌握的词里取，当前难度优先，洗牌且同轮不重复。
 * 已学过但未掌握的词不在这里——它们属于复习池，由场景层用存档档案单独补齐。
 * @param {object} opts { level, count, learnedWords, masteredWords }
 * @returns {object[]} 词条数组，最多 count 个
 */
export function pickFreshWords({ level, count, learnedWords = [], masteredWords = [] } = {}) {
  const exclude = new Set([].concat(learnedWords || [], masteredWords || []));
  const pool = getActiveWords().filter(item => !exclude.has(item.w));
  const primary = shuffle(pool.filter(item => item.lv === level));
  const others = shuffle(pool.filter(item => item.lv !== level));
  const max = (typeof count === 'number' && count > 0) ? Math.floor(count) : 0;
  return primary.concat(others).slice(0, max);
}

export function findWord(word) {
  return WORDS.find(item => item.w === word) || null;
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 从同难度里挑干扰项；不足时从全库补齐
function pickDistractors(correct, pool, count) {
  const sameLevel = pool.filter(item => item.w !== correct.w);
  let candidates = sameLevel;
  if (candidates.length < count) {
    // 补齐也只用活跃词库（排除已下线的四级），避免干扰项引入四级词
    const extra = WORDS.filter(item => item.w !== correct.w && item.lv !== correct.lv && ACTIVE_LEVELS.includes(item.lv));
    candidates = candidates.concat(extra);
  }
  return shuffle(candidates).slice(0, count);
}

function maskWord(word) {
  if (word.length <= 3) return word[0] + '_'.repeat(Math.max(1, word.length - 2)) + word[word.length - 1];
  const hide = Math.max(1, Math.round(word.length * 0.5));
  const startKeep = Math.ceil((word.length - hide) / 2);
  let out = '';
  for (let i = 0; i < word.length; i += 1) {
    out += (i < startKeep || i >= startKeep + hide) ? word[i] : '_';
  }
  return out;
}

/**
 * 为一个词条生成一道题。
 * @param {object} word 词条
 * @param {string[]} enabledTypes 启用的题型 id
 * @param {object[]} pool 同轮词池（用于干扰项）
 */
export function buildQuestion(word, enabledTypes, pool) {
  const types = enabledTypes && enabledTypes.length ? enabledTypes : QUESTION_TYPES.map(t => t.id);
  const type = types[Math.floor(Math.random() * types.length)];
  const distractors = pickDistractors(word, pool && pool.length ? pool : WORDS, 3);
  const options = shuffle([word].concat(distractors));

  const base = { word: word.w, type, level: word.lv };

  if (type === 'word2cn') {
    return Object.assign({}, base, {
      prompt: word.w,
      sub: word.ph + '  ' + word.pos,
      options: options.map(item => ({ value: item.w, label: item.cn })),
      answer: word.w,
      answerLabel: word.cn
    });
  }
  if (type === 'cn2word') {
    return Object.assign({}, base, {
      prompt: word.cn,
      sub: word.pos + '  ·  选出对应的英文单词',
      options: options.map(item => ({ value: item.w, label: item.w })),
      answer: word.w,
      answerLabel: word.w
    });
  }
  if (type === 'listen') {
    return Object.assign({}, base, {
      prompt: '听一听，选出你听到的单词',
      sub: word.ph,
      speak: word.w,
      options: options.map(item => ({ value: item.w, label: item.w })),
      answer: word.w,
      answerLabel: word.w
    });
  }
  return Object.assign({}, base, {
    prompt: word.cn,
    sub: word.pos + '  ·  ' + maskWord(word.w) + '  ·  ' + word.w.length + ' 个字母',
    options: null,
    answer: word.w,
    answerLabel: word.w
  });
}

// 组一轮练习：按词数取词（优先错词，其余随机），打乱后逐词出题
export function buildRound(level, count, wrongWords, enabledTypes) {
  const pool = getWordsByLevel(level);
  const wrongSet = Array.isArray(wrongWords) ? wrongWords.filter(w => pool.some(item => item.w === w)) : [];
  const rest = shuffle(pool.filter(item => !wrongSet.includes(item.w)));
  const chosen = shuffle(wrongSet).slice(0, count).concat(rest.slice(0, Math.max(0, count - wrongSet.length)));
  const words = shuffle(chosen.slice(0, count));
  return words.map(item => buildQuestion(item, enabledTypes, pool));
}
