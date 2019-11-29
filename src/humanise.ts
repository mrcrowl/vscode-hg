import * as path from 'path';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

class TimeSpan {
  private seconds: number;

  constructor(totalSeconds: number) {
    this.seconds = totalSeconds;
  }

  public get totalSeconds(): number {
    return this.seconds;
  }
  public get totalMinutes(): number {
    return this.seconds / 60;
  }
  public get totalHours(): number {
    return this.seconds / 3600;
  }
  public get totalDays(): number {
    return this.seconds / 86400;
  }
  public get totalWeeks(): number {
    return this.seconds / 604800;
  }
}

const AVERAGE_WEEKS_PER_MONTH = 4.34524;
const BULLET = '\u2022';
const FILE_LIST_LIMIT = 8;

export namespace humanise {
  export function formatFilesAsBulletedList(filenames: string[]): string {
    let extraCount = 0;
    if (filenames.length > FILE_LIST_LIMIT + 1) {
      extraCount = filenames.length - FILE_LIST_LIMIT;
      filenames = filenames.slice(0, FILE_LIST_LIMIT);
    }

    let osFilenames = filenames.map(f => f.replace(/[\/\\]/g, path.sep));
    let formatted = ` ${BULLET} ${osFilenames.join(`\n ${BULLET} `)}`;
    if (extraCount > 1) {
      const andNOthers = localize(
        'and n others',
        'and ${0} others',
        extraCount
      );
      formatted += `\n ${BULLET} ${andNOthers}`;
    }

    return formatted;
  }

  export function describeMerge(
    localBranchName: string,
    otherBranchName: string | undefined
  ): string {
    if (!otherBranchName || localBranchName === otherBranchName) {
      return localize('merge', 'Merge');
    } else {
      return localize(
        'merge into',
        'Merge {0} into {1}',
        otherBranchName,
        localBranchName
      );
    }
  }

  export function ageFromNow(date: Date): string {
    const elapsedSeconds = timeSince(date) / 1e3;
    let elapsed = new TimeSpan(elapsedSeconds);
    if (elapsed.totalDays > 0) {
      // past
      if (elapsed.totalSeconds < 15) {
        return 'a few moments ago';
      } else if (elapsed.totalSeconds < 60) {
        let seconds: string = pluraliseQuantity(
          'second',
          Math.floor(elapsed.totalSeconds),
          's'
        );
        return `${seconds} ago`;
      } else if (elapsed.totalMinutes < 60) {
        let minutes: string = pluraliseQuantity(
          'minute',
          Math.floor(elapsed.totalMinutes),
          's',
          ''
        );
        return `${minutes} ago`;
      } else if (elapsed.totalHours < 24) {
        let now: Date = new Date();
        let today: Date = datePart(now);
        let startDate: Date = datePart(addSeconds(now, -elapsedSeconds));
        let yesterday: Date = addDays(today, -1);

        if (startDate.getTime() == yesterday.getTime()) {
          return 'yesterday';
        } else {
          let hours: string = pluraliseQuantity(
            'hour',
            Math.floor(elapsed.totalHours),
            's',
            ''
          );
          return `${hours} ago`;
        }
      } else if (elapsed.totalDays < 7) {
        let now: Date = new Date();
        let today: Date = datePart(now);
        let startDate: Date = datePart(addSeconds(now, -elapsedSeconds));
        let yesterday: Date = addDays(today, -1);
        let wholeDays: number = Math.round(elapsed.totalDays);

        if (startDate.getTime() == yesterday.getTime()) {
          return 'yesterday';
        } else {
          let todayWeek: number = getWeek(today);
          let startWeek: number = getWeek(startDate);
          if (todayWeek == startWeek) {
            return `${Math.round(elapsed.totalDays)} days ago`;
          } else {
            return 'last week';
          }
        }
      } else {
        return date.toLocaleDateString(undefined, { formatMatcher: 'basic' });
      } /*if (elapsed.totalDays < 32) {
                let weeks: number = Math.round(elapsed.totalWeeks);
                if (weeks === 1) {
                    return "a week ago";
                }
                else {
                    return `${weeks} weeks ago`;
                }
            }
            else {
                let months: number = Math.round(elapsed.totalWeeks / AVERAGE_WEEKS_PER_MONTH);
                if (months === 1) {
                    return "a month ago";
                }
                else {
                    return `${months} months ago`;
                }
            }*/
    } else {
      // future
      //let totalDays: number = Math.floor(-elapsed.totalDays);
      //if (totalDays == 1)
      //{
      //    return "tomorrow";
      //}
      //else
      //{
      //    return "in the future";
      //}
      return 'now';
    }
  }

  function timeSince(date: Date): number {
    return Date.now() - date.getTime();
  }

  function addSeconds(date: Date, numberOfSeconds: number): Date {
    let adjustedDate: Date = new Date(date.getTime());
    adjustedDate.setSeconds(adjustedDate.getSeconds() + numberOfSeconds);
    return adjustedDate;
  }

  function addDays(date: Date, numberOfDays: number): Date {
    let adjustedDate: Date = new Date(date.getTime());
    adjustedDate.setDate(adjustedDate.getDate() + numberOfDays);
    return adjustedDate;
  }

  function datePart(date: Date): Date {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      0,
      0,
      0,
      0
    );
  }

  function getWeek(date: Date): number {
    let oneJan = new Date(date.getFullYear(), 0, 1);
    return Math.ceil(
      ((date.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7
    );
  }

  function pluraliseQuantity(
    word: string,
    quantity: number,
    pluralSuffix: string = 's',
    singularSuffix: string = '',
    singleQuantifier: string | null = null
  ) {
    return quantity == 1
      ? `${singleQuantifier || '1'} ${word}${singularSuffix}`
      : `${quantity} ${word}${pluralSuffix}`;
  }
}
