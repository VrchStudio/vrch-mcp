// Official square Paper master, copied unchanged from Viewer Pages.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const logo = readFileSync(new URL('./assets/vrch-logo-square-paper.png', import.meta.url));
export const logoPath = '/assets/vrch-logo-' + createHash('sha256').update(logo).digest('hex').slice(0,12) + '.png';
export const logoIcons = origin => [{src: origin + logoPath, mimeType: 'image/png', sizes: ['1024x1024']}];
