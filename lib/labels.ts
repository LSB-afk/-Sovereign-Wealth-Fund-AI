import type { CriterionKey, Decision, Relationship } from './types.ts';

export const decisionLabel: Record<Decision, string> = { selected: '선정', excluded: '제외', hold: '보류' };
export const relationshipLabel: Record<Relationship, string> = { business_competitor: '사업상 경쟁', financial_comparable: '재무 비교 적합', both: '사업 경쟁 + 재무 비교', none: '해당 없음' };
export const criterionLabel: Record<CriterionKey, string> = {
  product: '주요 제품·사업모델', customers: '매출 구성·고객군', scale: '기업 규모', growthProfitability: '성장성·수익성', dataSufficiency: '자료 충분성·비교 가능성',
};
export const assessmentLabel = { similar: '유사', partial: '부분 유사', different: '상이', unknown: '확인 불가' } as const;

// Tag → 한글 (지식그래프·프로필 표시용)
export const tagLabel: Record<string, string> = {
  data_center: '데이터센터', gaming: '게이밍', pro_visualization: '전문 시각화', automotive: '자동차', client_pc: 'PC', embedded: '임베디드',
  mobile: '모바일', broadband: '광대역', enterprise_software: '기업용 SW', iot: 'IoT', enterprise_networking: '기업 네트워킹', carrier: '통신사업자',
  industrial: '산업', personal_electronics: '개인 전자기기', communications: '통신', consumer: '소비자', hpc: 'HPC',
  gpu_accelerator: 'GPU·가속기', networking: '네트워킹', ai_platform_software: 'AI 플랫폼 SW', soc: 'SoC', cpu: 'CPU', fpga: 'FPGA', foundry: '파운드리',
  custom_asic: '맞춤형 ASIC', wireless_rf: '무선·RF', infrastructure_software: '인프라 SW', modem_rf: '모뎀·RF', ip_licensing: 'IP 라이선스',
  optical_interconnect: '광 인터커넥트', storage: '스토리지', memory: '메모리', analog: '아날로그', embedded_processing: '임베디드 프로세서', mixed_signal: '혼성신호', power: '전력',
};

export const relationLabel: Record<string, string> = {
  COMPETES_WITH: '경쟁사로 기재', SUPPLIES_TO: '공급', CUSTOMER_OF: '고객', PARTNERS_WITH: '협력', SELLS_INTO: '판매 시장', MAKES: '제품군',
};
