/* ---------------- 折り返し発信（追補 §3） ----------------
   資料パネルの〈折り返し発信〉に並ぶ番号。
   `open()` が真になった番号だけが並び、`resp()` が相手・時刻・生死・
   進行状況を見て応答を選ぶ。

   設計意図（追補 §3-3）
   - 繋がらないことを演出にする（消失中のレニィは留守電にすら落ちない／
     ゲルには最初から折り返せない）
   - かけると損をする番号を1つ置く（澪原中央病院）
   - 時刻依存を1つ置く（03:28〜03:42 のムニ回線）
   ---------------------------------------------------------- */
const DIALS = [
 {id:'len', label:'レニィ', num:'080-XXXX-2213',
  open:()=> F('MET_LEN'),
  resp(){
    const c = S.chars.LEN;
    if(c.life !== '生存') return {
      ring:'none', len:2, result:'応答なし',
      log:'呼び出し音が鳴らない。<br>留守番電話にも切り替わらない。——回線そのものが、どこにも繋がっていない。'};
    if(c.trust < 25) return {
      ring:'normal', len:2, result:'留守番電話',
      log:'「……はい、レニィだよぉ。いま出られないから、メッセージ入れてね」<br>録音された声。折り返しは、来なかった。'};
    return {
      ring:'normal', len:3, result:'応答あり', par:{c:'LEN', trust:3},
      log:'「……ふぁい。……あ、電話のひとだ」<br>完全に寝ぼけている。<br>「……うん、だいじょうぶ。声きけたから、もう寝るね」'};
  }},

 {id:'hyu', label:'ヒュウ', num:'080-XXXX-6621',
  open:()=> F('MET_HYU'),
  resp(){
    if(S.chars.HYU.life !== '生存') return {
      ring:'none', len:3, result:'圏外',
      log:'「——電波の届かない場所にいるか、電源が入っていないため……」<br>十七回、同じ言葉を聞いた。'};
    return {
      ring:'normal', len:3, result:'応答あり', par:{c:'HYU', trust:4, fear:-5},
      log:'「はい、ヒュウです。……おや、あなたから掛けてくださるとは」<br>「ふふ。今日はよく眠れそうです」'};
  }},

 {id:'jin', label:'ジンパチ', num:'090-XXXX-4408',
  open:()=> F('MET_JIN'),
  resp(){
    if(S.chars.JIN.life !== '生存') return {
      ring:'none', len:2, result:'応答なし',
      log:'呼び出し音。八回。……切れた。'};
    if(F('JIN_CALL_MISS')) return {
      ring:'normal', len:3, result:'応答あり', par:{c:'JIN', trust:5, doubt:-8},
      log:'「おう、どうした。……いや、なんでもねえならいい」<br>「……出てもらえるって、いいもんだな」'};
    return {
      ring:'normal', len:2, result:'応答あり', par:{c:'JIN', trust:3},
      log:'「おう。……なんだよ、用がねえのに掛けてくんのかよ」<br>まんざらでもない声だった。'};
  }},

 {id:'can', label:'カナタ', num:'090-XXXX-7751',
  open:()=> F('JIN_TAPE'),
  resp(){
    if(S.chars.JIN.life === '生存' && F('RIFT_CLOSED') && F('MUN_SAVED')) return {
      ring:'normal', len:4, result:'応答あり', set:{CAN_ANSWER:1},
      log:'「……はい、カナタです」<br>生きている声だった。<br>「着信、93件ありました。……全部あいつです」'};
    return {
      ring:'normal', len:3, result:'留守番電話',
      log:'「カナタです。いま出られません」<br>二週間前に録音された、生きている声。<br>この番号は、まだ生きたままになっている。'};
  }},

 {id:'ger', label:'ゲル', num:'非通知',
  open:()=> F('MET_GER'),
  resp(){ return {
    ring:'none', len:1, result:'発信不可',
    log:'番号が無い。<br>——こちらから手を伸ばせない相手が、一人いる。'}; }},

 {id:'mun', label:'0X-XXX-1994', num:'0X-XXX-1994',
  open:()=> F('MUN_LINE_01'),
  resp(){
    // 3:33 を挟む 03:28〜03:42 のあいだだけ、十年前に繋がる
    const m = S.clock % 1440;
    if(m >= 3*60+28 && m <= 3*60+42) return {
      ring:'old', len:5, result:'応答あり', noise:2, par:{c:'MUN', trust:8, fear:-8},
      set:{MUN_DIAL_01:1},
      log:'「……もしもし? ……あ! でんわのひとだ!」<br>「そっちからかけてくれたの、はじめてだね」<br>雨音。祭囃子。十年前が、受話器の中にある。'};
    return {
      ring:'none', len:2, result:'不通',
      log:'「おかけになった電話番号は、現在使われておりません」<br>——いまは、まだ繋がらない時刻だ。'};
  }},

 {id:'hos', label:'澪原中央病院', num:'0798-XX-XXXX',
  open:()=> F('MET_KAI'),
  resp(){ return {
    ring:'normal', len:4, result:'応答あり', noise:3, set:{KAI_ALERT:1},
    toast:'——こちらの存在を、知られた。',
    log:'「はい、当直室」<br>穏やかな声。左足を引きずる男の声だ。<br>「……ああ。あなたが、あの電話の人か」<br>「こちらからも、そのうち掛けさせてもらうよ」'}; }},

 {id:'mri', label:'室井', num:'090-XXXX-0031',
  open:()=> F('MRI_TAPE_HEARD'),
  resp(){
    if(F('NEO_ALLY_01')) return {
      ring:'old', len:4, result:'応答あり', noise:2, set:{MRI_DIAL_01:1},
      log:'砂嵐。ネオの回線を経由して、遠くで誰かが受話器を取った。<br>「…………ああ。」<br>「切らないで、くれたんだな」'};
    return {
      ring:'none', len:2, result:'不通',
      log:'「おかけになった電話番号は、現在使われておりません」<br>十年前に失踪した人の番号が、まだ解約されていない。'};
  }},

 {id:'sec', label:'発信者不明', num:'090-XXXX-1994',
  open:()=> S.loop >= 2,
  resp(){ return {
    ring:'old', len:3, result:'応答あり', noise:3, set:{SEC_CALL_01:1}, still:'s17',
    log:'呼び出し音が、こちら側とあちら側で二重に鳴っている。<br>「……もしもし。もしもーし。だれか、いますか」<br>幼い声だった。'}; }}
];
