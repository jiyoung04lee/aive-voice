# Development Log

## 2026-07-13

### 오늘 결정한 내용

- 프로젝트명: AIVE Voice Archive
- Repository: `aive-voice`
- 목적: 선배 인터뷰 음성을 RTZR STT API로 전사해 화자별 타임스탬프와 검색 기능을 제공하는 AIVE 확장 프로토타입
- 기술 스택:
  - Next.js App Router
  - TypeScript
  - Tailwind CSS
  - Next.js Route Handler
  - RTZR File STT OpenAPI

### 범위

필수 기능:
- 음성 파일 업로드
- RTZR STT API 실제 호출
- 전사 작업 ID 수신
- 상태 폴링
- 화자별 전사 결과 출력
- 타임스탬프 표시
- 오류 처리

추가 기능:
- 전사문 검색 및 하이라이트
- TXT 다운로드

실험 항목:
- 키워드 부스팅 적용 전후 비교

### 오늘 완료한 작업

- RTZR 개발자 사이트 가입
- 애플리케이션 이름 결정: AIVE Voice
- GitHub Public Repository `aive-voice` 생성
- 로컬 프로젝트 폴더 생성
- Next.js 프로젝트 초기화
- GitHub 원격 저장소 연결
- `.env.example, .env.local` 생성
- 기본 Next.js 실행 확인

### 확인한 사항

- RTZR 인증 정보는 서버에서만 사용
- `RTZR_CLIENT_ID`, `RTZR_CLIENT_SECRET`은 Public Repository에 포함하지 않음
- 실제 키는 `.env.local`에만 저장
- `.env.example`에는 변수명만 공개

### 다음 작업

- RTZR 인증 API 연결
- 테스트 음성으로 파일 전사 요청
- 작업 ID 반환 확인
- 전사 상태 폴링 확인
- 완료 결과 JSON 확인