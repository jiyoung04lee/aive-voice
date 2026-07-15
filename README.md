# AIVE Voice

AIVE Voice는 RTZR STT API를 이용해 2인 모의 인터뷰 음성을 화자별 대화록으로 변환하는 Next.js 웹 데모입니다. 타임스탬프와 검색, 개인정보 표시 마스킹, TXT 다운로드, 업로드 음성 재생 및 발화 동기화를 제공합니다.

긴 인터뷰 음성에는 유용한 경험이 담겨 있지만, 이를 직접 대화록으로 옮기고 필요한 내용을 다시 찾는 데 시간이 듭니다. AIVE Voice는 학과 커뮤니티 서비스 AIVE에서 선배 인터뷰 경험을 아카이브하는 기능을 검토하면서, 음성 업로드부터 전사 결과 탐색까지의 흐름을 검증하기 위해 만든 프로토타입입니다.

## 프로젝트 구조

- `app/page.tsx`
  - 파일 선택과 전사 요청
  - 5초 간격 상태 조회
  - 화자별 대화록과 검색·하이라이트
  - 마스킹 토글과 TXT 다운로드
  - 오디오 재생 및 발화 동기화
- `app/api/transcriptions/route.ts`
  - 업로드 파일과 키워드 검증
  - RTZR 파일 전사 요청 중계
- `app/api/transcriptions/[id]/route.ts`
  - 전사 상태 조회 중계
  - 완료·실패 결과 변환
- `lib/rtzr.ts`
  - RTZR 인증과 토큰 캐싱
  - 파일 전사 요청과 상태 조회
  - HTTP 401 발생 시 토큰 갱신 후 1회 재시도
- `lib/masking.ts`
  - 전화번호와 표준·구어체 이메일 표시 마스킹
- `docs/test-results.md`
  - 정상 흐름, 키워드 부스팅, 마스킹 및 오류 처리 실측 결과

## 1. Setup

### 요구 환경

- Node.js — 최소 버전은 별도로 검증하지 않았습니다.
- npm
- RTZR 개발자 계정과 API 인증 정보

### 저장소 복제 및 의존성 설치

```bash
git clone https://github.com/jiyoung04lee/aive-voice.git
cd aive-voice
npm ci
```

### 환경변수 설정

```bash
cp .env.example .env.local
```

`.env.local`에 발급받은 실제 값을 입력합니다.

```dotenv
RTZR_CLIENT_ID=
RTZR_CLIENT_SECRET=
```

- 실제 인증값은 `.env.local`에만 입력합니다.
- `.env.local`은 Git에 포함되지 않습니다.
- Client Secret을 브라우저 코드에 넣지 않습니다.
- 이 프로젝트는 로컬 실행을 기준으로 검증했습니다.

인증값 발급 방법은 [RTZR 인증 가이드](https://developers.rtzr.ai/docs/authentications/)를 참고하세요.

## 2. Run

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다.

1. `m4a`, `mp3`, `wav` 중 하나의 음성 파일을 선택합니다.
2. 필요한 경우 인식할 한글 키워드를 쉼표로 구분해 입력합니다.
3. **대화록 만들기**를 실행하고 전사가 완료될 때까지 기다립니다.
4. 완료 후 검색, 마스킹, TXT 다운로드, 오디오 재생과 타임스탬프 이동 기능을 사용합니다.

키워드는 완성형 한글 단어만 입력할 수 있습니다. 영문 회사명이나 약어도 `AIVE` 대신 `에이브`처럼 한글 발음으로 입력하며, 붙여 입력한 표기가 결과에서 같은 띄어쓰기로 출력되는 것은 아닙니다.

## 3. How it works

```text
브라우저에서 음성 파일 선택
        ↓
Next.js Route Handler
        ↓
RTZR 인증 토큰 발급 또는 캐시 재사용
        ↓
파일 전사 요청
        ↓
전사 작업 ID 반환
        ↓
브라우저에서 5초 간격 상태 조회
        ↓
completed / failed / timeout
        ↓
화자별 발화와 타임스탬프 표시
```

RTZR Client ID와 Client Secret은 서버 코드에서만 사용하며, 브라우저는 RTZR API에 직접 접근하지 않습니다. 인증 토큰은 모듈 수준에서 캐싱하고 만료 5분 전부터 새 토큰을 발급합니다. 동시에 인증 요청이 발생하면 진행 중인 Promise를 공유합니다.

전사 요청이나 상태 조회가 HTTP 401을 반환하면 캐시를 비우고 새 토큰으로 한 번만 재시도합니다. POST 재시도 시에는 파일과 설정으로 새로운 `FormData`를 만듭니다. 모듈 캐시는 현재 Node.js 프로세스 안에서만 유지되므로 서버 재시작 또는 다중 인스턴스 환경에서는 별도 캐시가 사용됩니다.

## Options

| 옵션 | 설정값 | 사용 이유 |
|---|---|---|
| `model_name` | `sommers` | 현재 프로젝트의 한국어 인터뷰 전사 모델로 사용합니다. |
| `language` | `ko` | 한국어로 진행한 모의 인터뷰를 전사합니다. |
| `use_diarization` | `true` | 서로 다른 화자의 발화를 구분합니다. |
| `diarization.spk_count` | `2` | 2인 인터뷰의 예상 화자 수를 전달합니다. |
| `use_itn` | `true` | 영어, 숫자, 단위 표현을 읽기 쉬운 표기로 변환합니다. |
| `use_disfluency_filter` | `true` | 간투어를 제거해 대화록의 가독성을 높입니다. |
| `use_paragraph_splitter` | `true` | 긴 전사 내용을 문단 단위로 나눕니다. |
| `paragraph_splitter.max` | `80` | 문단 최대 길이를 80자로 설정합니다. |
| `domain` | `GENERAL` | 일반적인 인터뷰 대화에 맞춰 일반 도메인을 사용합니다. |
| `keywords` | 사용자 입력 시에만 포함 | 회사명, 전공명, 직무명 등 주요 용어의 인식을 보조합니다. |

## Privacy masking

RTZR 개인정보 필터는 별도 계약이 필요한 기능입니다. 이 로컬 프로토타입은 전사 완료 후 정규식 기반 표시 후처리로 전화번호, 표준 이메일과 제한된 구어체 이메일을 가립니다. 구어체 이메일은 `앳`·`골뱅이`, `닷`·`점`, `컴` 등의 일부 표현만 처리합니다.

- 마스킹 ON: 화면과 TXT에서 `[전화번호]`, `[이메일]`로 표시
- 마스킹 OFF: 원본 전사문 표시
- 검색: 현재 마스킹 상태가 적용된 표시 문자열을 기준으로 수행

이 기능은 원본 RTZR 전사 결과를 브라우저 상태에서 삭제하지 않습니다. 서버 전송 전 비식별화나 저장 전 개인정보 삭제가 아니며, 이름, 주소, 주민등록번호, 계좌번호 등은 처리하지 않습니다. 완전한 개인정보 보호 기능으로 사용할 수 없습니다.

자세한 RTZR 기능은 [RTZR 개인정보 필터 문서](https://developers.rtzr.ai/docs/stt-file/pii/)를 참고하세요.

## Sample audio

> 테스트에는 직접 제작한 약 5분 분량의 2인 모의 인터뷰를 사용했습니다. 가상의 회사·인물·연락처만 포함했으며 실제 개인정보는 사용하지 않았습니다. 테스트 참여 동의를 받은 음성이고, 음성 파일과 전체 전사 결과는 저장소에 포함하지 않았습니다.

## Test results

- 약 5분 음성에서 발화 33개, 화자 2명으로 표시
- 파일 업로드부터 전사 결과 탐색까지의 핵심 사용자 흐름 확인
- 인증 토큰 캐싱과 강제 HTTP 401 이후 1회 재시도 확인
- 7개 키워드 중 3개에서 인식 개선 관찰
- 전화번호와 구어체 이메일 표시 마스킹 확인

키워드 부스팅 결과는 한 개의 테스트 음성에서 관찰한 사례이며, 일반적인 정확도 향상으로 해석하지 않습니다.

[테스트 및 실험 결과](docs/test-results.md)

## Known limitations

- 로컬 환경에서만 검증했습니다.
- 배포 플랫폼별 요청 크기와 실행 시간 제한은 별도로 검토하지 않았습니다.
- 화자 분리 정확도와 타임스탬프 오차를 정량 평가하지 않았습니다.
- 30분 타임아웃과 RTZR의 실제 `failed` 응답을 재현하지 않았습니다.
- 장시간·대용량 파일을 검증하지 않았습니다.
- 다른 브라우저와 모바일 환경을 검증하지 않았습니다.
- 키워드 부스팅이 모든 오인식을 교정하지는 않습니다.
- 개인정보 표시 마스킹의 처리 범위가 제한적입니다.

## Possible extensions

- LLM을 연결한 인터뷰 게시글 초안 생성
- 서버 단계 개인정보 비식별화 또는 NER 기반 탐지
- 화자 분리 및 타임스탬프 정량 평가

## References

- [RTZR 인증 가이드](https://developers.rtzr.ai/docs/authentications/)
- [RTZR File STT](https://developers.rtzr.ai/docs/stt-file/)
- [RTZR 키워드 부스팅](https://developers.rtzr.ai/docs/stt-file/keywords/)
- [RTZR 개인정보 필터](https://developers.rtzr.ai/docs/stt-file/pii/)
- [RTZR 공식 Python 튜토리얼의 STT Chapter Generator 예제](https://github.com/vito-ai/python-tutorial/tree/main/stt-chapter-generator)
