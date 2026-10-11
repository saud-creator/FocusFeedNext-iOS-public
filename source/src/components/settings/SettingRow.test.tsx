import { expect,it } from 'vitest';
import { render,screen } from '@testing-library/react';
import { SettingRow } from './SettingsSection';
import { Select,Switch } from '@/components/ui/primitives';
it('gives selection and toggle controls accessible names from the visible row labels',()=>{
  render(<><SettingRow label="Reading size" control={<Select><option>100%</option></Select>}/><SettingRow label="Haptics" control={<Switch/>}/></>);
  expect(screen.getByRole('combobox',{name:'Reading size'})).toBeInTheDocument();
  expect(screen.getByRole('switch',{name:'Haptics'})).toBeInTheDocument();
});
