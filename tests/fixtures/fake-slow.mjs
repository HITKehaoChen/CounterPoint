await new Promise((resolve) => setTimeout(resolve, 2000));
process.stdout.write('too late\n');
