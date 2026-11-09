# 구현·검증 기록 — 2026-11-09

| Area | Result |
|---|---|
| Files created/updated | `lib/agent.ts`, `financials.ts`, `peer.ts`, `publication.ts`, `report.ts`, `llm.ts`: 게시 검사·계산·출처 연결. `lib/runs.ts`, `app/api/runs/`, `app/Trust.tsx`: 실행 저장·재열람·승인. 기존 분석 화면/API·그래프·시점 비교의 표현/입력 검증과 회귀 테스트, README·평가 문서 갱신. |
| Decisions made | AI는 수집·선정 제안을 담당한다. 공식 숫자·설명·assessment는 코드가 구성한다. 위조·타기업·미래 출처, 근거 부족, AI 보류는 `hold`. 다른 회계기간 원값은 결합하지 않는다. 인용문 일치는 관계의 진실성 인증으로 취급하지 않는다. |
| Assumptions | 대상 NVDA/AMD와 기존 고정 후보군, 로컬 단일 사용자, 기존 의존성을 유지한다. 제품·시장 태그는 현재 큐레이션 입력이다. 새 패키지는 추가하지 않았다. |
| Validation performed | 회귀 테스트 44/44, 타입 검사, 프로덕션 빌드, diff 공백 검사 통과. Chromium에서 분석·탭·승인/반려·수정 Peer 승인 차단·기록 복원·MD/CSV 다운로드·그래프/시점 비교를 확인했고 pageerror 0건. 프로덕션 HTTP에서 입력 거부·키 없는 실제 모드 거부·AMD 분석·저장 payload 일치·검토 API·다른 서버에서의 기록 지속성을 확인했다. 별도 lint 도구는 기존 프로젝트에 설정되지 않았다. |
| Remaining risks | 실제 Claude/라이브 EDGAR 통합은 키·연락처 설정이 없어 미검증이다. 고정 테스트 통과는 일반 환각률 측정이 아니다. 큐레이션·발췌·비교 목적은 사람 검토가 필요하다. 로컬 해시는 인증/서명이 아니며 승인 기록은 마지막 판단을 보관한다. 공용 배포·24시간 감시·대화형 기준 조정은 이 범위에 포함하지 않는다. |
| Recommended next skill | 실제 API 설정 후 `harness-engineering:eval-design`의 동일 사례로 라이브 실행 원본을 수집하고 사람 평가를 수행한다. |
