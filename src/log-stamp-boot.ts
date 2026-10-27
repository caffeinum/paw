/** Side-effect import, FIRST in a daemon entry point, so lines logged while the rest loads are stamped too. */
import { installLogStamp } from "./log-stamp.ts";

installLogStamp();
