// The privacy page: plain text in the shared page's look; only the logo is drawn.
import '../shared/shared.css';
import { logoSVG, snapPixels } from '../ui/px';

snapPixels();
logoSVG(document.getElementById('logo') as unknown as SVGSVGElement);
