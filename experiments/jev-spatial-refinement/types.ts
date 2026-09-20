export type RefineCase = {
  id: string; stage: string; split: 'development' | 'confirmation' | 'regression';
  unit: string; arm: string; replicate: number;
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string,{type:'choice';instructions:string;criteria:Record<string,string>}>};
  expected: Record<string,string[]>; meta: any;
};
