const MOBILE_PHONE_PATTERN =
  /(?<!\d)(?:010\d{8}|010-\d{4}-\d{4}|010 \d{4} \d{4})(?!\d)/g;

const EMAIL_PATTERN =
  /(?<![A-Z0-9._%+-])[A-Z0-9_%+-]+(?:\.[A-Z0-9_%+-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,}(?![A-Z0-9-])/gi;

const SPOKEN_ENGLISH_LETTER_PATTERN =
  "(?:에이|비|씨|디|이|에프|지|에이치|아이|제이|케이|엘|엠|엔|오|피|큐|알|에스|티|유|브이|더블유|엑스|와이|제트)";

const SPOKEN_EMAIL_PATTERN = new RegExp(
  `(?<![가-힣A-Za-z0-9])(?:[가-힣]{1,20}|${SPOKEN_ENGLISH_LETTER_PATTERN}(?:\\s+${SPOKEN_ENGLISH_LETTER_PATTERN}){1,11})\\s+(?:앳|골뱅이)\\s+[가-힣]{1,20}\\s+(?:닷|점)\\s+(?:씨오케이알|오알지|케이알|컴|넷)(\\s*(?:앤드로|으로|로))?(?![가-힣A-Za-z0-9])`,
  "g",
);

export function maskPersonalInfo(text: string): string {
  return text
    .replace(MOBILE_PHONE_PATTERN, "[전화번호]")
    .replace(EMAIL_PATTERN, "[이메일]")
    .replace(
      SPOKEN_EMAIL_PATTERN,
      (_match, spokenSuffix: string | undefined) =>
        spokenSuffix ? "[이메일]로" : "[이메일]",
    );
}
